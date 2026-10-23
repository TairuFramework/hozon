import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { HozonDB, type StoreContext, sql, withKeyLock, withKeyLocks } from '../src/index.js'

function setup() {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register({
    name: 'sync',
    sync: { items: { key: ['id'], compare: ['version'] } },
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('items')
            .addColumn('id', 'text', (column) => column.primaryKey())
            .addColumn('version', 'integer')
            .execute()
        },
      },
    },
    createAPI: (query, _adapter, context) => ({ query, context }),
  })
  return db
}

test('compareWrite requires a declaration', async () => {
  const db = setup()
  try {
    const { context } = await db.getStore<{ context: StoreContext }>('sync')
    await expect(context.compareWrite('missing', { id: 'a' })).rejects.toThrow('declaration')
    expect(await context.compareWrite('items', { id: 'a', version: 2 })).toEqual({ changed: true })
    expect(await context.compareWrite('items', { id: 'a', version: 1 })).toEqual({ changed: false })
  } finally {
    await db.close()
  }
}, 10_000)

test('withKeyLock serializes calls within one transaction', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      if (!tx.withSavepoint) throw new Error('Missing savepoints')
      await tx.withSavepoint(async (sp) => {
        let active = 0
        let maximum = 0
        await Promise.all(
          [tx, sp, tx].map((provider) =>
            withKeyLock(provider, 'items', ['a'], async (locked) => {
              expect(locked).toBe(provider)
              active++
              maximum = Math.max(maximum, active)
              await new Promise<void>((resolve) => setTimeout(resolve, 10))
              active--
            }),
          ),
        )
        expect(maximum).toBe(1)
      })
    })
  } finally {
    await db.close()
  }
}, 10_000)

test('withKeyLocks releases queues after a callback fails', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      await expect(
        withKeyLocks(tx, 'items', [['b'], ['a'], ['a']], async () => {
          throw new Error('callback failed')
        }),
      ).rejects.toThrow('callback failed')
      expect(await withKeyLock(tx, 'items', ['a'], async () => 'released')).toBe('released')
    })
    await db.withScope(async (scope) => {
      expect(await withKeyLock(scope, 'items', ['a'], async (tx) => tx.isTransactionBound)).toBe(
        true,
      )
    })
  } finally {
    await db.close()
  }
}, 10_000)

test('compareWrite enforces the parameter limit for SQL expressions', async () => {
  const db = setup()
  try {
    const { context } = await db.getStore<{ context: StoreContext }>('sync')
    await expect(
      context.compareWrite('items', {
        id: 'a',
        version: sql`(${sql.join(
          Array.from({ length: 500 }, () => 1),
          sql` + `,
        )})`,
      }),
    ).rejects.toThrow('500 parameters')
  } finally {
    await db.close()
  }
}, 10_000)
