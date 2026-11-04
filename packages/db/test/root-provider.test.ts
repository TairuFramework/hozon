import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { HozonDB, type StoreProvider, withKeyLock } from '../src/index.js'

test.each([false, true])(
  'root identity survives transaction settlement (rollback: %s)',
  async (rollback) => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    db.register({
      name: 'items',
      migrations: {
        '0-init': {
          async up(query) {
            await query.schema.createTable('items').addColumn('id', 'text').execute()
          },
        },
      },
      createAPI: () => ({}),
    })
    const providers: Array<StoreProvider> = [db]
    try {
      const transaction = db.withScope(async (scope) => {
        providers.push(scope)
        await scope.withTransaction(async (tx) => {
          providers.push(tx)
          await tx.withScope?.(async (inline) => {
            providers.push(inline)
          })
          await withKeyLock(tx, 'items', ['key'], async (locked) => {
            providers.push(locked)
            await locked.withSavepoint?.(async (savepoint) => {
              providers.push(savepoint)
              await withKeyLock(savepoint, 'items', ['key'], async (nested) => {
                providers.push(nested)
              })
            })
          })
          for (const provider of providers) expect(provider.root).toBe(db)
          if (rollback) throw new Error('rollback')
        })
      })
      if (rollback) await expect(transaction).rejects.toThrow('rollback')
      else await transaction
      expect(providers).toHaveLength(7)
      for (const provider of providers) {
        expect(provider.root).toBe(db)
        expect(provider.root?.isTransactionBound).toBe(false)
        expect(await provider.root?.withTransaction(async (tx) => tx.root)).toBe(db)
      }
    } finally {
      await db.close()
    }
  },
)
