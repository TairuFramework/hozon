import { Kysely, sql } from 'kysely'
import { expect, test } from 'vitest'

import type { NativeBeginOptions, NativeDBHandle } from '../../adapter/src/native.js'
import { NativeAdapter } from '../src/index.js'
import { loadBinding } from './binding.js'

const sqlite = loadBinding()
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
    expect((await sql`SELECT big FROM fidelity`.execute(db)).rows).toEqual([{ big: 2147483648 }])
    expect((await sql`DELETE FROM fidelity`.execute(db)).numAffectedRows).toBe(1n)
  } finally {
    await db.destroy()
  }
})
test('driver returns safe integer cells as numbers and unsafe i64 cells as bigint', async () => {
  const adapter = new NativeAdapter({ sqlite, database: ':memory:' })
  const db = new Kysely({ dialect: adapter.dialect })
  try {
    const cases: Array<[bigint, number | bigint]> = [
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
      expect((await sql`SELECT ${input} AS value`.execute(db)).rows).toEqual([{ value: expected }])
    }
  } finally {
    await db.destroy()
  }
})

test('a rejected JS wait abandons a late native grant', async () => {
  // Delay delivery after the engine grants, simulating a cancelled JS continuation.
  const original = sqlite.beginWrite
  const delayed = {
    ...sqlite,
    beginWrite: (db: NativeDBHandle, options?: NativeBeginOptions) => {
      const pending = original(db, options)
      return {
        admissionID: pending.admissionID,
        granted: pending.granted.then(async (admission) => {
          await new Promise((resolve) => setTimeout(resolve, 60))
          return admission
        }),
      }
    },
  }
  const other = new NativeAdapter({ sqlite: delayed, database: ':memory:', admissionTimeoutMs: 20 })
  const otherDB = new Kysely({ dialect: other.dialect })
  try {
    await expect(otherDB.transaction().execute(async () => {})).rejects.toThrow('admission')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = await sqlite.beginWrite(await other.database, { timeoutMs: 40 }).granted
    await sqlite.rollback(await other.database, next.txID)
  } finally {
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

test('JS expiry abandons the pending admission before the holder releases', async () => {
  const abandoned: Array<string> = []
  let pendingOutcome: Promise<unknown> | undefined
  const cancellable = {
    ...sqlite,
    // Keep engine expiry longer than JS expiry, and preserve the pending ID.
    beginWrite: (db: string) => {
      const pending = sqlite.beginWrite(db, { timeoutMs: 1000 })
      pendingOutcome = pending.granted.then(
        () => 'unexpected grant',
        (error: unknown) => error,
      )
      return pending
    },
    abandon: async (db: string, admissionID: string) => {
      abandoned.push(admissionID)
      await sqlite.abandon(db, admissionID)
    },
  }
  const adapter = new NativeAdapter({
    sqlite: cancellable,
    database: ':memory:',
    admissionTimeoutMs: 20,
  })
  const driver = adapter.dialect.createDriver()
  const db = await adapter.database
  const holder = await sqlite.beginWrite(db).granted
  const connection = await driver.acquireConnection()
  try {
    await expect(driver.beginTransaction(connection, {})).rejects.toThrow('admission wait expired')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(abandoned).toHaveLength(1)
    await expect(pendingOutcome).resolves.toMatchObject({
      message: expect.stringContaining('abandoned'),
    })
    await expect(sqlite.execute(db, holder.txID, 'SELECT 1', [], 'read')).resolves.toMatchObject({
      rows: [[1]],
    })
  } finally {
    await sqlite.rollback(db, holder.txID)
    await driver.releaseConnection(connection)
    await driver.destroy()
  }
})

test('failed cleanup preserves the original commit error', async () => {
  const commitError = new Error('original commit failure')
  const rollbackError = new Error('later rollback failure')
  const failing = {
    ...sqlite,
    commit: async () => {
      throw commitError
    },
    rollback: async () => {
      throw rollbackError
    },
  }
  const adapter = new NativeAdapter({ sqlite: failing, database: ':memory:' })
  const db = new Kysely({ dialect: adapter.dialect })
  try {
    await expect(db.transaction().execute(async () => {})).rejects.toBe(commitError)
  } finally {
    await db.destroy()
  }
})
