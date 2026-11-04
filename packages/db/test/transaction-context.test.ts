import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test, vi } from 'vitest'

vi.mock('../src/transaction-context.js', () => ({
  createTransactionContext: async () => undefined,
}))

import { HozonDB } from '../src/index.js'

test('transaction providers work when async context is unavailable', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  try {
    await db.withTransaction(async (tx) => {
      expect(await tx.withTransaction(async (inner) => inner === tx)).toBe(true)
    })
  } finally {
    await db.close()
  }
})
