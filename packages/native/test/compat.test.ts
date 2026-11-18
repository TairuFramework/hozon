import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { CompiledQuery, Kysely } from 'kysely'
import { afterEach, expect, test } from 'vitest'

import { NativeAdapter } from '../src/index.js'
import { loadBinding } from './binding.js'

const sqlite = loadBinding()
const kinds = ['node-sqlite', 'native'] as const
type Kind = (typeof kinds)[number]
type Row = Record<string, unknown>
const directories: Array<string> = []
const busyTimeoutMs = 100

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-compat-'))
  directories.push(directory)
  return join(directory, 'compat.db')
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function open(kind: Kind, path: string) {
  const adapter =
    kind === 'native'
      ? new NativeAdapter({ sqlite, database: path, readers: 2, busyTimeoutMs })
      : new NodeSQLiteAdapter({
          database: path,
          pragmas: { journalMode: 'wal', busyTimeout: busyTimeoutMs, foreignKeys: true },
        })
  try {
    if (adapter instanceof NodeSQLiteAdapter) await adapter.prepare()
    else await adapter.database
  } catch (error) {
    await adapter.close()
    throw error
  }
  const db = new Kysely<unknown>({ dialect: adapter.dialect })
  return {
    query: async (sql: string, parameters: Array<unknown> = []) => {
      return (await db.executeQuery<Row>(CompiledQuery.raw(sql, parameters))).rows
    },
    close: () => db.destroy(),
  }
}

async function withDB<T>(
  kind: Kind,
  path: string,
  run: (db: Awaited<ReturnType<typeof open>>) => Promise<T>,
) {
  const db = await open(kind, path)
  try {
    return await run(db)
  } finally {
    await db.close()
  }
}

async function walBytes(path: string) {
  return readFile(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return new Uint8Array()
    throw error
  })
}

// The child never closes: SIGKILL must leave committed frames and an unfinished transaction.
const childProgram = `
const [kind, path, action, bindingPath, adapterURL] = process.argv.slice(1)
const { createRequire } = await import('node:module')
const require = createRequire(adapterURL)
let execute, begin
if (kind === 'native') {
  const sqlite = require(bindingPath)
  const db = await sqlite.open(path, { readers: 2, busyTimeoutMs: 100, journalMode: 'wal' })
  execute = (sql, tx = null) => sqlite.execute(db, tx, sql, [], 'write')
  begin = async () => (await sqlite.beginWrite(db).granted).txID
} else {
  const { NodeSQLiteAdapter } = await import(adapterURL)
  const adapter = new NodeSQLiteAdapter({ database: path, pragmas: { busyTimeout: 100 } })
  await adapter.prepare()
  execute = async (sql) => adapter.database.exec(sql)
  begin = async () => { adapter.database.exec('BEGIN IMMEDIATE'); return null }
}
if (action === 'crash') {
  await execute('CREATE TABLE recovery (value TEXT)')
  await execute("INSERT INTO recovery VALUES ('committed')")
}
const tx = await begin()
await execute(action === 'crash'
  ? "INSERT INTO recovery VALUES ('uncommitted')"
  : 'INSERT INTO contention VALUES (2)', tx)
process.send('ready')
setInterval(() => {}, 1000)
`

async function startChild(kind: Kind, path: string, action: 'crash' | 'lock') {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      childProgram,
      kind,
      path,
      action,
      fileURLToPath(new URL('../native/hozon-sqlite-napi.node', import.meta.url)),
      new URL('../../node-sqlite/lib/index.js', import.meta.url).href,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  )
  let stderr = ''
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  const exited = once(child, 'exit')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      once(child, 'message').then(([message]) => expect(message).toBe('ready')),
      exited.then(([code, signal]) => {
        throw new Error(`Child exited ${code}/${signal}: ${stderr}`)
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Child readiness timed out: ${stderr}`)), 5000)
      }),
    ])
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  } finally {
    clearTimeout(timer)
  }
  return async () => {
    expect(child.kill('SIGKILL')).toBe(true)
    expect(await exited).toEqual([null, 'SIGKILL'])
  }
}

for (const creator of kinds) {
  const other: Kind = creator === 'native' ? 'node-sqlite' : 'native'
  test(`${creator} files round-trip through ${other} with identical scalar rows`, async () => {
    const path = await databasePath()
    const expected = [
      {
        entry_key: 'entry-1',
        text: 'Café 東京 — مرحبا',
        integer: 2147483648,
        real: 1.25,
        blob: new Uint8Array([0, 127, 128, 255]),
        nullable: null,
        truth: 1,
        falsity: 0,
      },
    ]
    const before = await withDB(creator, path, async (db) => {
      await db.query(
        'CREATE TABLE entries (entry_key TEXT PRIMARY KEY, text TEXT, integer INTEGER, real REAL, blob BLOB, nullable TEXT, truth INTEGER, falsity INTEGER)',
      )
      await db.query('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        'entry-1',
        'Café 東京 — مرحبا',
        2147483648,
        1.25,
        new Uint8Array([0, 127, 128, 255]),
        null,
        true,
        false,
      ])
      return db.query('SELECT * FROM entries ORDER BY entry_key')
    })
    expect(before).toEqual(expected)
    await withDB(other, path, async (db) => {
      expect(await db.query('SELECT * FROM entries ORDER BY entry_key')).toEqual(before)
      await db.query("UPDATE entries SET text = text || ' reopened'")
    })
    await withDB(creator, path, async (db) => {
      expect(await db.query('SELECT * FROM entries ORDER BY entry_key')).toEqual([
        { ...expected[0], text: 'Café 東京 — مرحبا reopened' },
      ])
    })
  })

  test(`${creator} enforces foreign keys and pins WAL and busy timeout`, async () => {
    await withDB(creator, await databasePath(), async (db) => {
      expect(await db.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
      expect(await db.query('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }])
      expect(await db.query('PRAGMA busy_timeout')).toEqual([{ timeout: busyTimeoutMs }])
      await db.query('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      await db.query('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))')
      await expect(db.query('INSERT INTO child VALUES (42)')).rejects.toThrow(/FOREIGN KEY/i)
      await db.query('INSERT INTO parent VALUES (42)')
      await db.query('INSERT INTO child VALUES (42)')
      await expect(db.query('DELETE FROM parent')).rejects.toThrow(/FOREIGN KEY/i)
      expect(await db.query('SELECT * FROM child')).toEqual([{ parent_id: 42 }])
    })
  })

  test(`${creator} waits for the configured busy timeout on an external writer`, async () => {
    const path = await databasePath()
    await withDB(creator, path, async (db) => {
      await db.query('CREATE TABLE contention (value INTEGER)')
      const kill = await startChild(creator, path, 'lock')
      try {
        const started = performance.now()
        await expect(db.query('INSERT INTO contention VALUES (1)')).rejects.toThrow(/locked|busy/i)
        const elapsed = performance.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(busyTimeoutMs * 0.75)
        expect(elapsed).toBeLessThan(2000)
      } finally {
        await kill()
      }
      await db.query('INSERT INTO contention VALUES (3)')
      expect(await db.query('SELECT * FROM contention')).toEqual([{ value: 3 }])
    })
  })

  test(`${creator} clean close checkpoints WAL before ${other} reopens`, async () => {
    const path = await databasePath()
    await withDB(creator, path, async (db) => {
      await db.query('CREATE TABLE checkpoint (value TEXT)')
      await db.query("INSERT INTO checkpoint VALUES ('durable')")
      expect((await walBytes(path)).byteLength).toBeGreaterThan(32)
    })
    expect((await walBytes(path)).byteLength).toBe(0)
    // A standalone main-file copy proves data was checkpointed, independent of WAL recovery.
    const copy = `${path}.checkpointed`
    await copyFile(path, copy)
    await withDB(other, copy, async (db) => {
      expect(await db.query('SELECT * FROM checkpoint')).toEqual([{ value: 'durable' }])
    })
  })

  for (const reopener of kinds) {
    test(`${creator} SIGKILL recovers committed WAL and rolls back unfinished rows under ${reopener}`, async () => {
      const path = await databasePath()
      const kill = await startChild(creator, path, 'crash')
      try {
        expect((await walBytes(path)).byteLength).toBeGreaterThan(32)
      } finally {
        await kill()
      }
      expect((await walBytes(path)).byteLength).toBeGreaterThan(32)
      await withDB(reopener, path, async (db) => {
        expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(await db.query('SELECT * FROM recovery')).toEqual([{ value: 'committed' }])
        await db.query("INSERT INTO recovery VALUES ('after recovery')")
      })
      await withDB(creator, path, async (db) => {
        expect(await db.query('SELECT * FROM recovery ORDER BY value')).toEqual([
          { value: 'after recovery' },
          { value: 'committed' },
        ])
      })
    })
  }
}

const corpus: Array<[string, string]> = [
  ['a', 'Project launch notes: SQLite mobile sync, offline-first collaboration.'],
  ['b', 'SQLite SQLite sync: project launch notes and offline collaboration.'],
  ['c', 'Café résumé naïve — co-operate; email alice@example.org. SQLite sync!'],
  ['d', 'CAFÉ resume: café, résumé, punctuation… sync?'],
  ['e', '東京 日本語 SQLite 同期。離線筆記'],
  ['f', 'مرحبا بالعالم — SQLite sync ملاحظات'],
  ['g', 'Привет мир: SQLite sync и заметки'],
  ['h', 'Project launch notes: SQLite mobile sync, offline-first collaboration.'],
  ['i', 'Planning a garden: tomatoes, basil, and spring rain.'],
  ['j', "Developer's notes: snake_case, C++, version 3.54; sync-ing."],
]

test('SQLite versions meet the mobile baseline and kubun JSON/FTS queries agree', async () => {
  const path = await databasePath()
  const snapshots = []
  const matches = [
    'sqlite',
    'sync',
    '"project launch"',
    'cafe',
    'résumé',
    '東京',
    'مرحبا',
    'Привет',
    '"co operate"',
    'offline*',
    'sqlite OR garden',
  ]
  for (const kind of kinds) {
    snapshots.push(
      await withDB(kind, path, async (db) => {
        if (kind === 'node-sqlite') {
          await db.query('CREATE TABLE documents (entry_key TEXT PRIMARY KEY, data TEXT)')
          await db.query('INSERT INTO documents VALUES (?, ?)', [
            'doc',
            JSON.stringify({
              field: 'Café',
              count: 42,
              active: true,
              tags: ['a', '東京'],
              nil: null,
              nested: { value: 1.25 },
            }),
          ])
          await db.query('CREATE VIRTUAL TABLE search USING fts5(entry_key UNINDEXED, text)')
          for (const [key, text] of corpus)
            await db.query('INSERT INTO search VALUES (?, ?)', [key, text])
        }
        const version = (await db.query('SELECT sqlite_version() AS version'))[0]?.version
        expect(typeof version).toBe('string')
        const [major, minor] = String(version).split('.').map(Number)
        expect((major ?? 0) * 1000 + (minor ?? 0)).toBeGreaterThanOrEqual(3053)
        const json = await db.query(`SELECT data ->> 'field' AS field, data ->> 'count' AS count,
        data ->> 'active' AS active, json_extract(data, '$.nested.value') AS nested,
        json_array_length(data, '$.tags') AS length, json_type(data, '$.tags') AS type,
        json_type(data, '$.nil') AS nil, json_type(data, '$.missing') AS missing FROM documents`)
        expect(json).toEqual([
          {
            field: 'Café',
            count: 42,
            active: 1,
            nested: 1.25,
            length: 2,
            type: 'array',
            nil: 'null',
            missing: null,
          },
        ])
        const each = await db.query(`SELECT j.key, j.value, j.type FROM documents,
        json_each(json_extract(data, '$.tags')) AS j ORDER BY j.key`)
        expect(each).toEqual([
          { key: 0, value: 'a', type: 'text' },
          { key: 1, value: '東京', type: 'text' },
        ])
        const fts = []
        for (const match of matches) {
          const rows = await db.query(
            'SELECT entry_key, rank FROM search WHERE search MATCH ? ORDER BY rank, entry_key',
            [match],
          )
          expect(rows.length, match).toBeGreaterThan(0)
          fts.push(rows)
        }
        // Default unicode61 folds case/diacritics and breaks punctuation; duplicate texts tie by key.
        expect(fts[matches.indexOf('cafe')]?.map((row) => row.entry_key).sort()).toEqual(['c', 'd'])
        expect(fts[matches.indexOf('"co operate"')]?.map((row) => row.entry_key)).toEqual(['c'])
        const ties = fts[0]?.filter((row) => row.entry_key === 'a' || row.entry_key === 'h')
        expect(ties?.map((row) => row.entry_key)).toEqual(['a', 'h'])
        expect(ties?.[0]?.rank).toBe(ties?.[1]?.rank)
        return { version, json, each, fts }
      }),
    )
  }
  console.info(
    'SQLite compatibility versions',
    snapshots.map(({ version }) => version),
    'expo-sqlite baseline 3.53.3',
  )
  expect(snapshots[1]?.json).toEqual(snapshots[0]?.json)
  expect(snapshots[1]?.each).toEqual(snapshots[0]?.each)
  expect(snapshots[1]?.fts).toEqual(snapshots[0]?.fts)
})

test('safe integer cells are numbers and unsafe integers are exact or explicitly rejected', async () => {
  const path = await databasePath()
  const safe = [0, 2147483648, 2200000000000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]
  const unsafe = [
    9007199254740992n,
    9007199254740993n,
    -9007199254740992n,
    -9007199254740993n,
    9223372036854775807n,
    -9223372036854775808n,
  ]
  await withDB('native', path, async (db) => {
    await db.query('CREATE TABLE integers (id INTEGER PRIMARY KEY, value INTEGER)')
    for (const [id, value] of [...safe, ...unsafe].entries()) {
      await db.query('INSERT INTO integers VALUES (?, ?)', [id, value])
    }
    const rows = await db.query('SELECT value FROM integers ORDER BY id')
    expect(rows.map((row) => row.value)).toEqual([...safe, ...unsafe])
    for (const row of rows.slice(0, safe.length)) expect(typeof row.value).toBe('number')
    for (const row of rows.slice(safe.length)) expect(typeof row.value).toBe('bigint')
  })
  await withDB('node-sqlite', path, async (db) => {
    const rows = await db.query('SELECT value FROM integers WHERE id < ? ORDER BY id', [
      safe.length,
    ])
    expect(rows.map((row) => row.value)).toEqual(safe)
    for (const row of rows) expect(typeof row.value).toBe('number')
    for (const [offset, value] of unsafe.entries()) {
      try {
        const result = await db.query('SELECT value FROM integers WHERE id = ?', [
          safe.length + offset,
        ])
        console.info('node-sqlite unsafe integer', String(value), result[0]?.value)
        const cell = result[0]?.value
        expect(['number', 'bigint']).toContain(typeof cell)
        expect(BigInt(cell as number | bigint)).toBe(value)
      } catch (error) {
        // Only the explicit node:sqlite range error is an acceptable alternative to exact cells.
        expect(error).toMatchObject({ code: 'ERR_OUT_OF_RANGE' })
        console.info('node-sqlite unsafe integer', String(value), 'ERR_OUT_OF_RANGE')
      }
    }
  })
})
