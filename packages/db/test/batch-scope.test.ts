import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, expect, test, vi } from 'vitest'

import { HozonDB } from '../src/index.js'

type KVStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}
type Stores = { kv: KVStore }
const databases: Array<HozonDB> = []
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close()
  vi.restoreAllMocks()
})
async function setup() {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  databases.push(db)
  db.register<{ kv: { key: string; value: string } }, KVStore>({
    name: 'kv',
    migrations: {
      '0-init': {
        async up(db) {
          await db.schema
            .createTable('kv')
            .addColumn('key', 'text', (col) => col.primaryKey())
            .addColumn('value', 'text', (col) => col.notNull())
            .execute()
        },
      },
    },
    createAPI(db, _adapter, context) {
      const loader = context.createLoader<string, string>({
        maxBatchSize: 500,
        async load(keys) {
          const rows = await db.selectFrom('kv').selectAll().where('key', 'in', keys).execute()
          const result = new Map<string, string | null>(keys.map((key) => [key, null]))
          for (const row of rows) result.set(row.key, row.value)
          return result
        },
      })
      return {
        get: (key) => loader.load(key),
        async set(key, value) {
          loader.dispatch()
          await db
            .insertInto('kv')
            .values({ key, value })
            .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
            .execute()
          loader.clear(key)
        },
      }
    },
  })
  const store = await db.getStore<KVStore>('kv')
  await store.set('a', 'v1')
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const queryCount = () =>
    prepare.mock.calls.filter(([sql]) => /select .* from "hozon_kv"/i.test(sql)).length
  return { db, store, queryCount, prepare }
}
test('base provider batches concurrent gets into one query', async () => {
  const { store, queryCount } = await setup()
  expect(await Promise.all([store.get('a'), store.get('missing'), store.get('a')])).toEqual([
    'v1',
    null,
    'v1',
  ])
  expect(queryCount()).toBe(1)
})
test('base provider reads fresh after a batch settles', async () => {
  const { store, queryCount } = await setup()
  expect(await store.get('a')).toBe('v1')
  expect(await store.get('a')).toBe('v1')
  expect(queryCount()).toBe(2)
})
test('a scope remembers results until a write clears them', async () => {
  const { db, queryCount } = await setup()
  await db.withScope<Stores, void>(async (scope) => {
    const store = await scope.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    expect(await store.get('a')).toBe('v1')
    expect(queryCount()).toBe(1)
    await store.set('a', 'b')
    expect(await store.get('a')).toBe('b')
    expect(queryCount()).toBe(2)
  })
})
test('a scoped store used after the scope ends remembers nothing', async () => {
  const { db, queryCount } = await setup()
  const store = await db.withScope<Stores, KVStore>(async (scope) => {
    const store = await scope.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    return store
  })
  expect(await store.get('a')).toBe('v1')
  expect(await store.get('a')).toBe('v1')
  expect(queryCount()).toBe(3)
})
test('a transaction remembers results', async () => {
  const { db, queryCount } = await setup()
  await db.withTransaction<Stores, void>(async (tx) => {
    const store = await tx.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    expect(await store.get('a')).toBe('v1')
    expect(queryCount()).toBe(1)
  })
})
test('savepoint rollback drops values written inside it', async () => {
  const { db } = await setup()
  await db.withTransaction<Stores, void>(async (tx) => {
    const store = await tx.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    if (tx.withSavepoint == null) throw new Error('Missing savepoints')
    let hookRead: Promise<string | null> | undefined
    await expect(
      tx.withSavepoint<Stores, void>(async (sp) => {
        const savepointStore = await sp.getStore('kv')
        expect(savepointStore).not.toBe(store)
        await savepointStore.set('a', 'v2')
        expect(await savepointStore.get('a')).toBe('v2')
        sp.onRollback(() => {
          hookRead = store.get('a')
        })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await hookRead).toBe('v1')
    expect(await store.get('a')).toBe('v1')
  })
})
test('a load pending at savepoint rollback settles with a value', async () => {
  const { db } = await setup()
  await db.withTransaction<Stores, void>(async (tx) => {
    const store = await tx.getStore('kv')
    if (tx.withSavepoint == null) throw new Error('Missing savepoints')
    let pending: Promise<string | null> | undefined
    await expect(
      tx.withSavepoint(async () => {
        await store.set('a', 'v2')
        pending = store.get('a')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await pending).toBe('v2')
    expect(await store.get('a')).toBe('v1')
  })
})
test.each([false, true])(
  'a load pending at transaction end settles with a value (rollback: %s)',
  async (rollback) => {
    const { db } = await setup()
    let pending: Promise<string | null> | undefined
    const transaction = db.withTransaction<Stores, void>(async (tx) => {
      const store = await tx.getStore('kv')
      await store.set('a', 'v2')
      pending = store.get('a')
      if (rollback) throw new Error('rollback')
    })
    if (rollback) await expect(transaction).rejects.toThrow('rollback')
    else await transaction
    expect(await pending).toBe('v2')
  },
)
test('a transaction committed from a scope clears the scope before commit hooks', async () => {
  const { db } = await setup()
  await db.withScope<Stores, void>(async (scope) => {
    const store = await scope.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    let pending: Promise<string | null> | undefined
    await scope.withTransaction<Stores, void>(async (tx) => {
      await (await tx.getStore('kv')).set('a', 'v2')
      tx.onCommit(() => {
        pending = store.get('a')
      })
    })
    expect(await pending).toBe('v2')
  })
})
test('withScope on a transaction provider runs inline with the transaction stores', async () => {
  const { db, queryCount } = await setup()
  await db.withTransaction<Stores, void>(async (tx) => {
    const store = await tx.getStore('kv')
    expect(await store.get('a')).toBe('v1')
    if (tx.withScope == null) throw new Error('Missing scopes')
    await tx.withScope<Stores, void>(async (scope) => {
      expect(scope).toBe(tx)
      expect(await scope.getStore('kv')).toBe(store)
      expect(await store.get('a')).toBe('v1')
    })
    expect(queryCount()).toBe(1)
  })
})

test('a scope closes after rejection and nested scopes share stores and hooks', async () => {
  const { db, queryCount } = await setup()
  let captured: KVStore | undefined
  const commitHook = vi.fn()
  const rollbackHook = vi.fn()
  await expect(
    db.withScope<Stores, void>(async (scope) => {
      captured = await scope.getStore('kv')
      expect(scope.hasStore('kv')).toBe(true)
      expect(scope.withSavepoint).toBeUndefined()
      scope.onCommit(commitHook)
      expect(commitHook).toHaveBeenCalledOnce()
      scope.onRollback(rollbackHook)
      expect(await captured.get('a')).toBe('v1')
      if (scope.withScope == null) throw new Error('Missing scopes')
      await scope.withScope<Stores, void>(async (nested) => {
        expect(nested).toBe(scope)
        expect(await nested.getStore('kv')).toBe(captured)
      })
      throw new Error('scope failed')
    }),
  ).rejects.toThrow('scope failed')
  expect(rollbackHook).not.toHaveBeenCalled()
  expect(await captured?.get('a')).toBe('v1')
  expect(await captured?.get('a')).toBe('v1')
  expect(queryCount()).toBe(3)
})

test('pending loads dispatch before savepoint creation and release', async () => {
  const { db, prepare } = await setup()
  await db.withTransaction<Stores, void>(async (tx) => {
    const store = await tx.getStore('kv')
    if (tx.withSavepoint == null) throw new Error('Missing savepoints')
    const before = store.get('a')
    let inside: Promise<string | null> | undefined
    await tx.withSavepoint(async () => {
      inside = store.get('missing')
    })
    expect(await before).toBe('v1')
    expect(await inside).toBeNull()
    const statements = prepare.mock.calls.map(([sql]) => sql)
    const selectIndexes = statements.flatMap((sql, index) =>
      /select .* from "hozon_kv"/i.test(sql) ? [index] : [],
    )
    expect(selectIndexes).toHaveLength(2)
    expect(selectIndexes[0]).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('SAVEPOINT ')),
    )
    expect(selectIndexes[1]).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('RELEASE SAVEPOINT ')),
    )
  })
})

test('a load settling after scope close cannot restore remembered values', async () => {
  const { db, queryCount } = await setup()
  let pending: Promise<string | null> | undefined
  const store = await db.withScope<Stores, KVStore>(async (scope) => {
    const store = await scope.getStore('kv')
    pending = store.get('a')
    return store
  })
  expect(await pending).toBe('v1')
  expect(await store.get('a')).toBe('v1')
  expect(await store.get('a')).toBe('v1')
  expect(queryCount()).toBe(3)
})
