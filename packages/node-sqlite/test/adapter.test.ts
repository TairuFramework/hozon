import { Kysely } from 'kysely'
import { describe, expect, test } from 'vitest'

import { NodeSQLiteAdapter } from '../src/index.js'

type Database = {
  values: {
    value: boolean
  }
}

describe('NodeSQLiteAdapter', () => {
  test('binds booleans as 1/0', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const db = new Kysely<Database>({ dialect: adapter.dialect })

    await db.schema.createTable('values').addColumn('value', 'integer').execute()
    await db
      .insertInto('values')
      .values([{ value: true }, { value: false }])
      .execute()

    const rows = await db.selectFrom('values').select('value').orderBy('value', 'desc').execute()

    expect(rows.map(({ value }) => value)).toEqual([1, 0])
    await db.destroy()
    await adapter.close()
  })

  test('applies connection pragmas on open', () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })

    expect(adapter.database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    expect(adapter.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  test('allows connection pragma overrides', () => {
    const adapter = new NodeSQLiteAdapter({
      database: ':memory:',
      pragmas: { busyTimeout: 100, foreignKeys: false },
    })

    expect(adapter.database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 100 })
    expect(adapter.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 })
  })

  test('prepare on :memory: is a no-op', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })

    await expect(adapter.prepare()).resolves.toBeUndefined()
  })

  test('close before first query and double close are safe', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })

    await adapter.close()
    await adapter.close()
  })
})
