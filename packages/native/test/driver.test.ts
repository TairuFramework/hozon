import { Kysely, sql } from 'kysely'
import { expect, test } from 'vitest'

import { NativeAdapter } from '../src/index.js'
import { serialize } from '../src/serialize.js'
import { loadBinding } from './binding.js'

const sqlite = loadBinding()
test('serialize preserves bigint and blobs and converts JS values', () => {
  const blob = new Uint8Array([0, 255])
  expect(
    serialize([true, false, undefined, null, 9223372036854775807n, blob, new Date(0), { a: 1 }]),
  ).toEqual([1, 0, null, null, 9223372036854775807n, blob, '1970-01-01T00:00:00.000Z', '{"a":1}'])
  expect(() => serialize([Symbol('bad')])).toThrow('Unsupported')
})
test('non-empty encryption keys fail loudly', () => {
  expect(
    () => new NativeAdapter({ sqlite, database: ':memory:', encryptionKey: new Uint8Array([1]) }),
  ).toThrow('SQLCipher')
})
test('real driver preserves types and raw write metadata including RETURNING', async () => {
  const adapter = new NativeAdapter({ sqlite, database: ':memory:' })
  const db = new Kysely({ dialect: adapter.dialect })
  try {
    await sql`CREATE TABLE fidelity (id INTEGER PRIMARY KEY, big INTEGER, blob BLOB, absent, flag, json, date)`.execute(
      db,
    )
    const blob = new Uint8Array([0, 255, 127])
    const inserted =
      await sql`INSERT INTO fidelity VALUES (NULL, ${9223372036854775807n}, ${blob}, ${null}, ${true}, ${{ a: 1 }}, ${new Date(0)}) RETURNING *`.execute(
        db,
      )
    expect(inserted.numAffectedRows).toBe(1n)
    expect(inserted.insertId).toBe(1n)
    expect(inserted.rows).toEqual([
      {
        id: 1,
        big: 9223372036854775807n,
        blob,
        absent: null,
        flag: 1,
        json: '{"a":1}',
        date: '1970-01-01T00:00:00.000Z',
      },
    ])
    expect((await sql`UPDATE fidelity SET big = ${2147483648n}`.execute(db)).numAffectedRows).toBe(
      1n,
    )
    expect((await sql`SELECT big FROM fidelity`.execute(db)).rows).toEqual([{ big: 2147483648n }])
    expect((await sql`DELETE FROM fidelity`.execute(db)).numAffectedRows).toBe(1n)
  } finally {
    await db.destroy()
  }
})
test('a rejected JS wait abandons a late native grant', async () => {
  const adapter = new NativeAdapter({ sqlite, database: ':memory:', admissionTimeoutMs: 20 })
  const db = new Kysely({ dialect: adapter.dialect })
  const holder = await sqlite.beginWrite(await adapter.database)
  // Delay delivery after the engine grants, simulating a cancelled JS continuation.
  const original = sqlite.beginWrite
  const delayed = {
    ...sqlite,
    beginWrite: async (...args: Parameters<typeof original>) => {
      const admission = await original(...args)
      await new Promise((resolve) => setTimeout(resolve, 60))
      return admission
    },
  }
  const other = new NativeAdapter({ sqlite: delayed, database: ':memory:', admissionTimeoutMs: 20 })
  const otherDB = new Kysely({ dialect: other.dialect })
  try {
    await expect(otherDB.transaction().execute(async () => {})).rejects.toThrow('admission')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = await sqlite.beginWrite(await other.database, { timeoutMs: 40 })
    await sqlite.rollback(await other.database, next.txID)
  } finally {
    await sqlite.rollback(await adapter.database, holder.txID)
    await db.destroy()
    await otherDB.destroy()
  }
})

test('raw classification ignores write words in reads and detects CTE writes and PRAGMA setters', async () => {
  const adapter = new NativeAdapter({ sqlite, database: ':memory:' })
  const db = new Kysely({ dialect: adapter.dialect })
  const driver = adapter.dialect.createDriver()
  try {
    await sql`CREATE TABLE raw_modes (id INTEGER)`.execute(db)
    await sql`WITH source AS (SELECT 3 AS id) INSERT INTO raw_modes SELECT id FROM source`.execute(
      db,
    )
    const holder = await driver.acquireConnection()
    await driver.beginTransaction(holder, {})
    try {
      const read = sql`SELECT replace('update', 'up', 'UP') AS text`.execute(db)
      await expect(
        Promise.race([
          read,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('raw read blocked')), 100),
          ),
        ]),
      ).resolves.toMatchObject({ rows: [{ text: 'UPdate' }] })
      await sql`PRAGMA table_info(raw_modes)`.execute(db)
    } finally {
      await driver.rollbackTransaction(holder)
      await driver.releaseConnection(holder)
    }
    await expect(sql`EXPLAIN UPDATE raw_modes SET id = 4`.execute(db)).resolves.toHaveProperty(
      'rows',
    )
    await sql`PRAGMA user_version(7)`.execute(db)
    expect((await sql`PRAGMA user_version`.execute(db)).rows).toEqual([{ user_version: 7 }])
  } finally {
    await db.destroy()
  }
})
