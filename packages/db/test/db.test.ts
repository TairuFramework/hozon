import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { describe, expect, test, vi } from 'vitest'

import { HozonDB, HozonDBClosedError, InvalidTablePrefixError } from '../src/index.js'

describe('HozonDB', () => {
  test('register and getStore triggers migrations', async () => {
    let migrationRan = false
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })

    db.register<{ test_items: { id: string } }, { getItem: (id: string) => Promise<unknown> }>({
      name: 'test',
      migrations: {
        '0-init': {
          async up(db: Kysely<Record<string, unknown>>) {
            migrationRan = true
            await db.schema
              .createTable('test_items')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .execute()
          },
          async down() {},
        },
      },
      createAPI: (db, _adapter) => ({
        async getItem(id: string) {
          return db.selectFrom('test_items').selectAll().where('id', '=', id).executeTakeFirst()
        },
      }),
    })

    expect(migrationRan).toBe(false) // not yet — lazy
    const store = await db.getStore<{ getItem: (id: string) => Promise<unknown> }>('test')
    expect(migrationRan).toBe(true) // now — triggered by getStore
    expect(store.getItem).toBeDefined()
    await db.close()
  })

  test('getStore caches API instance', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    db.register({
      name: 'test',
      migrations: {},
      createAPI: (_db, _adapter) => ({ value: 42 }),
    })

    const store1 = await db.getStore<{ value: number }>('test')
    const store2 = await db.getStore<{ value: number }>('test')
    expect(store1).toBe(store2) // same reference
    await db.close()
  })

  test('getStore throws for unregistered store', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    await expect(db.getStore('nope')).rejects.toThrow('Store "nope" is not registered')
    await db.close()
  })

  test('dependsOn resolves dependency migrations first', async () => {
    const order: Array<string> = []
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })

    db.register({
      name: 'base',
      migrations: {
        '0-init': {
          async up() {
            order.push('base')
          },
          async down() {},
        },
      },
      createAPI: () => ({}),
    })

    db.register({
      name: 'dependent',
      dependsOn: ['base'],
      migrations: {
        '0-init': {
          async up() {
            order.push('dependent')
          },
          async down() {},
        },
      },
      createAPI: () => ({}),
    })

    await db.getStore('dependent')
    expect(order).toEqual(['base', 'dependent'])
    await db.close()
  })

  test('concurrent getStore calls share same migration promise', async () => {
    let migrationCount = 0
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })

    db.register({
      name: 'test',
      migrations: {
        '0-init': {
          async up() {
            migrationCount++
          },
          async down() {},
        },
      },
      createAPI: () => ({ ok: true }),
    })

    const [s1, s2] = await Promise.all([db.getStore('test'), db.getStore('test')])
    expect(migrationCount).toBe(1)
    expect(s1).toBe(s2)
    await db.close()
  })

  test('register is idempotent for same store name', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    const def = {
      name: 'test',
      migrations: {},
      createAPI: () => ({ value: 1 }),
    }
    db.register(def)
    db.register(def) // should not throw
    const store = await db.getStore<{ value: number }>('test')
    expect(store.value).toBe(1)
    await db.close()
  })

  test('failed migration is retried on next getStore call', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    let attempt = 0

    db.register({
      name: 'flaky',
      migrations: {
        '0-init': {
          async up(db: Kysely<Record<string, unknown>>) {
            attempt++
            if (attempt === 1) {
              throw new Error('transient failure')
            }
            await db.schema
              .createTable('flaky_table')
              .addColumn('id', 'text', (col) => col.primaryKey())
              .execute()
          },
          async down() {},
        },
      },
      createAPI: () => ({ ok: true }),
    })

    await expect(db.getStore('flaky')).rejects.toThrow('transient failure')
    const store = await db.getStore<{ ok: boolean }>('flaky')
    expect(store.ok).toBe(true)
    expect(attempt).toBe(2)
    await db.close()
  })

  test('migrations with function form receive MigrationContext', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    let receivedTypes: unknown = null
    let receivedKind: unknown = null

    db.register({
      name: 'test',
      migrations: (ctx) => {
        receivedTypes = ctx.types
        receivedKind = ctx.kind
        return {}
      },
      createAPI: () => ({}),
    })

    await db.getStore('test')
    expect(receivedTypes).toHaveProperty('text')
    expect(receivedTypes).toHaveProperty('binary')
    expect(receivedKind).toBe('sqlite')
    await db.close()
  })
})

describe('HozonDB lifecycle', () => {
  test('rejects invalid tablePrefix', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    for (const prefix of ['Kubun', '1x', 'a-b', "a'b", 'x'.repeat(32), '']) {
      expect(() => new HozonDB({ adapter, tablePrefix: prefix })).toThrow(InvalidTablePrefixError)
    }
    await adapter.close()
  })

  test('concurrent first getStore and migrate migrate once', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    let migrationRuns = 0
    db.register({
      name: 's',
      migrations: {
        '0-init': {
          async up() {
            migrationRuns++
          },
        },
      },
      createAPI: () => ({}),
    })
    const [a, b] = await Promise.all([db.getStore('s'), db.getStore('s'), db.migrate()])
    expect(migrationRuns).toBe(1)
    expect(a).toBe(b)
    await db.close()
  })

  test('use after close rejects', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    await db.close()
    await expect(db.getStore('s')).rejects.toThrow(HozonDBClosedError)
    await expect(db.migrate()).rejects.toThrow('HozonDB is closed')
    await expect(db.withTransaction(async () => {})).rejects.toThrow('HozonDB is closed')
  })

  test.each([false, true])(
    'close calls adapter.close once (initialized: %s)',
    async (initialized) => {
      const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
      const close = vi.spyOn(adapter, 'close')
      const db = new HozonDB({ adapter })
      if (initialized) await db.migrate()
      await Promise.all([db.close(), db.close()])
      await db.close()
      expect(close).toHaveBeenCalledTimes(1)
      expect(adapter.database.isOpen).toBe(false)
    },
  )

  test('root hooks and adapter getter', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const db = new HozonDB({ adapter })
    const hooks: Array<string> = []
    db.onCommit(() => hooks.push('commit'))
    db.onRollback(() => hooks.push('rollback'))
    expect(hooks).toEqual(['commit'])
    expect(db.adapter).toBe(adapter)
    await db.close()
  })

  test('custom prefix isolates migration tables and savepoints', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const statements = vi.spyOn(adapter.database, 'prepare')
    const db = new HozonDB({ adapter, tablePrefix: 'kubun' })
    db.register({ name: 's', migrations: { '0-init': { async up() {} } }, createAPI: () => ({}) })
    await db.withTransaction(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await tx.withSavepoint(async () => {})
    })
    expect(statements).toHaveBeenCalledWith('SAVEPOINT kubun_sp_1')
    expect(
      adapter.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%migration%'")
        .all()
        .map((row) => row.name)
        .sort(),
    ).toEqual(['kubun_s_migration', 'kubun_s_migration_lock'])
    await db.close()
  })
})

test('hasStore does not trigger migrations or prepare', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  const prepare = vi.spyOn(adapter, 'prepare')
  db.register({ name: 'present', migrations: {}, createAPI: () => ({}) })
  expect(db.hasStore('present')).toBe(true)
  expect(db.hasStore('absent')).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  await db.withTransaction(async (tx) => {
    expect(tx.hasStore('present')).toBe(true)
    expect(tx.hasStore('absent')).toBe(false)
    await expect(tx.getStore('absent')).rejects.toThrow('Store "absent" is not registered')
  })
  await db.close()
})
