import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, expect, test, vi } from 'vitest'

import { HozonDB, SchemaVersionError } from '../src/index.js'

const instances: Array<HozonDB> = []
afterEach(async () => {
  await Promise.all(instances.splice(0).map((db) => db.close()))
})

function setup() {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  instances.push(db)
  const prepare = vi.spyOn(adapter, 'prepare')
  return { db, adapter, prepare }
}

function seed(adapter: NodeSQLiteAdapter, store: string) {
  adapter.database.exec(
    `CREATE TABLE hozon_${store}_migration (name text PRIMARY KEY, timestamp text NOT NULL); INSERT INTO hozon_${store}_migration VALUES ('0-init', '2026-01-01'), ('1-next', '2026-01-02')`,
  )
}

function register(db: HozonDB, name: string, dependsOn?: Array<string>) {
  db.register({
    name,
    dependsOn,
    migrations: {
      '0-init': {
        async up(db) {
          await db.schema.createTable(`data_${name}`).addColumn('id', 'text').execute()
        },
      },
    },
    createAPI: () => ({ ok: true }),
  })
}

test('unknown executed migration throws SchemaVersionError before prepare', async () => {
  const { db, adapter, prepare } = setup()
  seed(adapter, 'a')
  register(db, 'a')
  await expect(db.migrate()).rejects.toThrow(SchemaVersionError)
  await expect(db.migrate()).rejects.toThrow(
    'Database schema for store "a" is newer than this version supports (unknown migrations: 1-next)',
  )
  expect(prepare).not.toHaveBeenCalled()
})

test.each([undefined, ['b']])(
  'a newer second store blocks all writes (dependsOn: %s)',
  async (dependsOn) => {
    const { db, adapter, prepare } = setup()
    register(db, 'a', dependsOn)
    seed(adapter, 'b')
    register(db, 'b')
    await expect(db.getStore('a')).rejects.toThrow(SchemaVersionError)
    expect(prepare).not.toHaveBeenCalled()
    expect(
      adapter.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'hozon_a_migration' OR name = 'data_a'",
        )
        .all(),
    ).toEqual([])
  },
)

test('store with empty migrations is still checked', async () => {
  const { db, adapter, prepare } = setup()
  seed(adapter, 'a')
  db.register({ name: 'a', migrations: {}, createAPI: () => ({}) })
  await expect(db.withTransaction(async () => {})).rejects.toThrow(SchemaVersionError)
  expect(prepare).not.toHaveBeenCalled()
})

test('unregistered store migration tables are ignored', async () => {
  const { db, adapter, prepare } = setup()
  seed(adapter, 'absent')
  register(db, 'a')
  await db.migrate()
  expect(await db.getStore('a')).toEqual({ ok: true })
  expect(prepare).toHaveBeenCalledTimes(1)
})

test('late-registered store is checked on its own', async () => {
  const { db, adapter, prepare } = setup()
  register(db, 'a')
  await db.migrate()
  seed(adapter, 'c')
  register(db, 'c')
  await expect(db.getStore('c')).rejects.toThrow(SchemaVersionError)
  expect(await db.getStore('a')).toEqual({ ok: true })
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(
    adapter.database.prepare("SELECT name FROM sqlite_master WHERE name = 'data_c'").all(),
  ).toEqual([])
})

test('prepare runs exactly once across migrate, getStore and withTransaction', async () => {
  const { db, prepare } = setup()
  register(db, 'a')
  await Promise.all([db.migrate(), db.getStore('a'), db.withTransaction(async () => {})])
  await db.migrate()
  expect(prepare).toHaveBeenCalledTimes(1)
})

test('malformed migration tables fail without prepare or writes', async () => {
  const { db, adapter, prepare } = setup()
  adapter.database.exec('CREATE TABLE hozon_a_migration (wrong_column text)')
  register(db, 'a')
  await expect(db.migrate()).rejects.toThrow('no such column: name')
  expect(prepare).not.toHaveBeenCalled()
  expect(
    adapter.database.prepare("SELECT name FROM sqlite_master WHERE name = 'data_a'").all(),
  ).toEqual([])
})

test('a transient check failure is retried on the next call', async () => {
  const { db, adapter, prepare } = setup()
  adapter.database.exec('CREATE TABLE hozon_a_migration (wrong_column text)')
  register(db, 'a')
  await expect(db.migrate()).rejects.toThrow('no such column: name')
  adapter.database.exec('DROP TABLE hozon_a_migration')
  await db.migrate()
  expect(await db.getStore('a')).toEqual({ ok: true })
  expect(prepare).toHaveBeenCalledTimes(1)
})

test('a transient prepare failure is retried, then success stays cached', async () => {
  const { db, prepare } = setup()
  register(db, 'a')
  prepare.mockRejectedValueOnce(new Error('prepare failed'))
  await expect(db.migrate()).rejects.toThrow('prepare failed')
  await db.migrate()
  expect(await db.getStore('a')).toEqual({ ok: true })
  await db.withTransaction(async () => {})
  expect(prepare).toHaveBeenCalledTimes(2)
})

test('concurrent callers share one preflight attempt, including a retry', async () => {
  const { db, prepare } = setup()
  register(db, 'a')
  const failure = new Error('prepare failed')
  prepare.mockRejectedValueOnce(failure)
  const failed = await Promise.allSettled([
    db.migrate(),
    db.getStore('a'),
    db.withTransaction(async () => {}),
  ])
  expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
  for (const result of failed) expect((result as PromiseRejectedResult).reason).toBe(failure)
  expect(prepare).toHaveBeenCalledTimes(1)
  await Promise.all([db.migrate(), db.getStore('a'), db.withTransaction(async () => {})])
  expect(prepare).toHaveBeenCalledTimes(2)
})
