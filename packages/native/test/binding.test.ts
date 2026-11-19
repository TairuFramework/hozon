import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { loadBinding } from './binding.js'

const sqlite = loadBinding()
const options = {
  readers: 4,
  busyTimeoutMs: 5000,
  journalMode: 'wal',
  expireAdmissions: true,
} as const

test('cached writer selects refresh columns after schema changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-schema-cache-'))
  const db = await sqlite.open(join(directory, 'test.db'), options)
  try {
    for (const transaction of [false, true]) {
      const tx = transaction ? (await sqlite.beginWrite(db).granted).txID : null
      const query = (sql: string) => sqlite.execute(db, tx, sql, [], 'write')
      await query('CREATE TABLE items (id INTEGER)')
      await query('INSERT INTO items VALUES (1), (2)')
      const select = 'SELECT * FROM items ORDER BY id'
      for (let run = 0; run < 2; run++) {
        expect(await query(select)).toMatchObject({ columns: ['id'], rows: [[1], [2]] })
      }
      await query("ALTER TABLE items ADD COLUMN label TEXT NOT NULL DEFAULT 'default'")
      for (let run = 0; run < 3; run++) {
        expect(await query(select)).toMatchObject({
          columns: ['id', 'label'],
          rows: [[1, 'default'], [2, 'default']],
        })
      }
      await query('ALTER TABLE items DROP COLUMN label')
      for (let run = 0; run < 3; run++) {
        expect(await query(select)).toMatchObject({ columns: ['id'], rows: [[1], [2]] })
      }
      await query('DROP TABLE items')
      if (tx !== null) await sqlite.commit(db, tx)
    }
  } finally {
    await sqlite.close(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test('boundary validates handles, mode, bigint range and unsafe numbers', async () => {
  const db = await sqlite.open(':memory:', options)
  try {
    expect(() => sqlite.execute('bad', null, 'SELECT 1', [], 'read')).toThrow('HOZON_INVALID_INPUT')
    expect(() => sqlite.execute(db, null, 'SELECT ?', [9223372036854775808n], 'read')).toThrow(
      'i64',
    )
    expect(() =>
      sqlite.execute(db, null, 'SELECT ?', [Number.MAX_SAFE_INTEGER + 1], 'read'),
    ).toThrow('unsafe integer')
    await expect(sqlite.execute(db, null, 'SELECT ?', [], 'read')).rejects.toThrow('HOZON_SQLITE')
    await expect(sqlite.execute(db, '999999999', 'SELECT 1', [], 'read')).rejects.toThrow(
      'HOZON_INVALID_TRANSACTION',
    )
    await expect(
      sqlite.execute(db, null, 'SELECT ?', [new Uint8Array([1])], 'read'),
    ).resolves.toMatchObject({ rows: [[new Uint8Array([1])]] })
    expect(
      (
        await sqlite.execute(
          db,
          null,
          'SELECT ?, ?, ?',
          [-9223372036854775808n, 2147483648n, 1.25],
          'read',
        )
      ).rows,
    ).toEqual([[-9223372036854775808n, 2147483648, 1.25]])
    await expect(
      sqlite.execute(db, null, 'SELECT * FROM missing_table', [], 'read'),
    ).rejects.toThrow('HOZON_SQLITE')
  } finally {
    await sqlite.close(db)
  }
})

test('integer cells use numbers exactly through both safe boundaries and bigint beyond', async () => {
  const db = await sqlite.open(':memory:', options)
  try {
    await sqlite.execute(db, null, 'CREATE TABLE integers (value INTEGER)', [], 'write')
    const cases: Array<[number | bigint, number | bigint]> = [
      [2147483648, 2147483648],
      [2200000000000, 2200000000000],
      [9007199254740991, 9007199254740991],
      [-9007199254740991, -9007199254740991],
      [2147483648n, 2147483648],
      [2200000000000n, 2200000000000],
      [9007199254740991n, 9007199254740991],
      [-9007199254740991n, -9007199254740991],
      [9007199254740992n, 9007199254740992n],
      [-9007199254740992n, -9007199254740992n],
      [9223372036854775807n, 9223372036854775807n],
      [-9223372036854775808n, -9223372036854775808n],
    ]
    for (const [input, expected] of cases) {
      const inserted = await sqlite.execute(
        db,
        null,
        'INSERT INTO integers VALUES (?) RETURNING value',
        [input],
        'write',
      )
      expect(inserted.rows).toEqual([[expected]])
      expect(inserted.changes).toBe(1n)
      expect(typeof inserted.lastInsertRowID).toBe('bigint')
      expect(
        (await sqlite.execute(db, null, 'SELECT value FROM integers', [], 'read')).rows,
      ).toEqual([[expected]])
      await sqlite.execute(db, null, 'DELETE FROM integers', [], 'write')
    }
    // Metadata stays bigint even when the insert ID is a safe integer above i32.
    await sqlite.execute(db, null, 'CREATE TABLE ids (id INTEGER PRIMARY KEY)', [], 'write')
    const result = await sqlite.execute(
      db,
      null,
      'INSERT INTO ids VALUES (?) RETURNING id',
      [2200000000000n],
      'write',
    )
    expect(result.rows).toEqual([[2200000000000]])
    expect(result.changes).toBe(1n)
    expect(result.lastInsertRowID).toBe(2200000000000n)
  } finally {
    await sqlite.close(db)
  }
})

test('admission diagnostics include the calling and holding JS stacks', async () => {
  const db = await sqlite.open(':memory:', options)
  async function holderSite() {
    return sqlite.beginWrite(db).granted
  }
  async function callerSite() {
    return sqlite.beginWrite(db, { timeoutMs: 30 }).granted
  }
  const holder = await holderSite()
  try {
    await expect(callerSite()).rejects.toThrow(/HOZON_ADMISSION_EXPIRED:.*callerSite.*holderSite/s)
  } finally {
    await sqlite.rollback(db, holder.txID)
    await sqlite.close(db)
  }
})

test('close rolls back active rows on disk and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-native-'))
  const path = join(directory, 'test.db')
  let db = await sqlite.open(path, options)
  try {
    await sqlite.execute(db, null, 'CREATE TABLE rows (id INTEGER)', [], 'write')
    const tx = await sqlite.beginWrite(db).granted
    await sqlite.execute(db, tx.txID, 'INSERT INTO rows VALUES (1)', [], 'write')
    const pending = sqlite.beginWrite(db).granted.then(
      () => 'unexpected grant',
      (error: unknown) => error,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await sqlite.close(db)
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('closed')
    await sqlite.close(db)
    db = await sqlite.open(path, options)
    expect((await sqlite.execute(db, null, 'SELECT * FROM rows', [], 'read')).rows).toEqual([])
  } finally {
    await sqlite.close(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test('clean close checkpoints committed WAL data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-checkpoint-'))
  const path = join(directory, 'test.db')
  const db = await sqlite.open(path, options)
  try {
    await sqlite.execute(db, null, 'CREATE TABLE rows (id INTEGER)', [], 'write')
    await sqlite.execute(db, null, 'INSERT INTO rows VALUES (1)', [], 'write')
    await sqlite.close(db)
    // A checkpointed close either removes the WAL or leaves it truncated.
    const wal = await readFile(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return new Uint8Array()
      throw error
    })
    expect(wal.byteLength).toBe(0)
  } finally {
    await sqlite.close(db)
    await rm(directory, { recursive: true, force: true })
  }
})

test('boundary rejects fractional option values before dispatch', async () => {
  const attempt = async () => {
    const db = await sqlite.open(':memory:', { ...options, readers: 1.5 })
    await sqlite.close(db)
  }
  await expect(attempt()).rejects.toThrow('readers')
})

test('beginWrite synchronously returns a cancellable pending admission object', async () => {
  const db = await sqlite.open(':memory:', options)
  try {
    const holder = await sqlite.beginWrite(db).granted
    const pending = sqlite.beginWrite(db, { timeoutMs: 1000 })
    // Observe rejection even while asserting the synchronous contract.
    const outcome = pending.granted.catch((error: unknown) => error)
    expect(pending).not.toBeInstanceOf(Promise)
    expect(pending.admissionID).toEqual(expect.any(String))
    expect(pending.granted).toBeInstanceOf(Promise)
    await sqlite.abandon(db, pending.admissionID)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining('abandoned') })
    await sqlite.execute(db, holder.txID, 'SELECT 1', [], 'read')
    await sqlite.rollback(db, holder.txID)
    const next = sqlite.beginWrite(db)
    const grant = await next.granted
    expect(grant.admissionID).toBe(next.admissionID)
    await sqlite.abandon(db, next.admissionID)
    await expect(sqlite.execute(db, grant.txID, 'SELECT 1', [], 'read')).rejects.toThrow(
      'HOZON_INVALID_TRANSACTION',
    )
  } finally {
    await sqlite.close(db)
  }
})

test('invalid begin input rejects granted while preserving pending shape', async () => {
  for (const [db, options] of [
    ['bad', undefined],
    ['0', { timeoutMs: -1 }],
    ['0', { timeoutMs: 0.5 }],
  ] as const) {
    const pending = sqlite.beginWrite(db, options)
    expect(typeof pending.admissionID).toBe('string')
    await expect(pending.granted).rejects.toThrow('HOZON_INVALID_INPUT')
  }
})

test.each([true, false])(
  'explicit admission expiry %s overrides build default',
  async (expireAdmissions) => {
    const db = await sqlite.open(':memory:', {
      readers: 2,
      busyTimeoutMs: 100,
      journalMode: 'wal',
      expireAdmissions,
    })
    expect(sqlite.admissionExpiry(db)).toBe(expireAdmissions)
    const holder = await sqlite.beginWrite(db).granted
    const pending = sqlite.beginWrite(db, { timeoutMs: 20 })
    const outcome = pending.granted.then(
      () => 'granted',
      (error: Error) => error.message,
    )
    try {
      if (expireAdmissions) expect(await outcome).toContain('HOZON_ADMISSION_EXPIRED')
      else {
        expect(
          await Promise.race([
            outcome,
            new Promise((resolve) => setTimeout(() => resolve('pending'), 60)),
          ]),
        ).toBe('pending')
        await sqlite.abandon(db, pending.admissionID)
        await outcome
      }
    } finally {
      await sqlite.rollback(db, holder.txID)
      await sqlite.close(db)
    }
  },
)
