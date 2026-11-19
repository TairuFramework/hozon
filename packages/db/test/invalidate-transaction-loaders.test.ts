import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { type BatchLoader, HozonDB, type StoreProvider } from '../src/index.js'

type Rows = { loader: BatchLoader<string, string>; write(value: string): Promise<void> }
type Stores = { rows: Rows }

async function setup() {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let queries = 0
  db.register<{ rows: { id: string; value: string } }, Rows>({
    name: 'rows',
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('rows')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('value', 'text')
            .execute()
          await query.insertInto('rows').values({ id: 'x', value: 'before' }).execute()
        },
      },
    },
    createAPI(query, _adapter, context) {
      return {
        loader: context.createLoader({
          maxBatchSize: 500,
          async load(keys: Array<string>) {
            queries++
            const rows = await query
              .selectFrom('rows')
              .selectAll()
              .where('id', 'in', keys)
              .execute()
            return new Map(rows.map((row) => [row.id, row.value]))
          },
        }),
        async write(value) {
          await query.updateTable('rows').set({ value }).where('id', '=', 'x').execute()
        },
      }
    },
  })
  return { db, queries: () => queries }
}

test('invalidation dispatches pending loads before clearing, so they cannot restore the cache', async () => {
  const { db, queries } = await setup()
  try {
    await db.withTransaction<Stores, void>(async (tx) => {
      const rows = await tx.getStore('rows')
      const pending = rows.loader.load('x')
      expect(queries()).toBe(0)
      db.invalidateTransactionLoaders(tx)
      // Dispatch starts synchronously, before invalidation returns.
      expect(queries()).toBe(1)
      expect(await pending).toBe('before')
      await rows.write('after')
      expect(await rows.loader.load('x')).toBe('after')
      expect(queries()).toBe(2)
    })
  } finally {
    await db.close()
  }
})

test('invalidation rejects root, unrelated, and settled providers', async () => {
  const { db } = await setup()
  const other = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let settled: StoreProvider | undefined
  try {
    expect(() => db.invalidateTransactionLoaders(db)).toThrow()
    await db.withTransaction(async (tx) => {
      settled = tx
      expect(() => other.invalidateTransactionLoaders(tx)).toThrow()
      expect(() => db.invalidateTransactionLoaders(tx)).not.toThrow()
    })
    expect(settled).toBeDefined()
    expect(() => db.invalidateTransactionLoaders(settled as StoreProvider)).toThrow()
  } finally {
    await db.close()
    await other.close()
  }
})
