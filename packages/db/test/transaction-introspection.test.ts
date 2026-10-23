import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { HozonDB, type StoreProvider } from '../src/index.js'

test('isTransactionBound reflects the provider', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  try {
    expect(db.isTransactionBound).toBe(false)
    expect(db.transactionRoot).toBeUndefined()
    await db.withScope(async (scope) => {
      expect(scope.isTransactionBound).toBe(false)
      expect(scope.transactionRoot).toBeUndefined()
      await scope.withTransaction(async (tx) => {
        expect(tx.isTransactionBound).toBe(true)
        expect(tx.transactionRoot).toBe(tx)
        expect(scope.isTransactionBound).toBe(false)
        expect(scope.transactionRoot).toBeUndefined()
      })
    })
    await db.withTransaction(async (tx) => {
      expect(tx.isTransactionBound).toBe(true)
      if (!tx.withSavepoint) throw new Error('Missing savepoints')
      await tx.withSavepoint(async (sp) => {
        expect(sp.isTransactionBound).toBe(true)
      })
    })
  } finally {
    await db.close()
  }
})

test('transactionRoot is shared across savepoints', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  try {
    await db.withTransaction(async (tx) => {
      expect(tx.transactionRoot).toBe(tx)
      await tx.withTransaction(async (nested) => {
        expect(nested.transactionRoot).toBe(tx)
      })
      if (!tx.withScope || !tx.withSavepoint) throw new Error('Missing scopes or savepoints')
      await tx.withScope(async (scope) => {
        expect(scope.isTransactionBound).toBe(true)
        expect(scope.transactionRoot).toBe(tx)
      })
      await tx.withSavepoint(async (sp) => {
        expect(sp).not.toBe(tx)
        expect(sp.transactionRoot).toBe(tx.transactionRoot)
        if (!sp.withSavepoint || !sp.withScope) throw new Error('Missing scopes or savepoints')
        await sp.withScope(async (scope) => {
          expect(scope.isTransactionBound).toBe(true)
          expect(scope.transactionRoot).toBe(tx)
        })
        await sp.withSavepoint(async (nested) => {
          expect(nested.transactionRoot).toBe(tx)
        })
      })
    })
  } finally {
    await db.close()
  }
})

test('independent transactions have distinct roots', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let previous: StoreProvider | undefined
  try {
    for (let index = 0; index < 2; index++) {
      await db.withTransaction(async (tx) => {
        expect(tx.transactionRoot).toBe(tx)
        expect(tx.transactionRoot).not.toBe(previous)
        previous = tx.transactionRoot
      })
    }
  } finally {
    await db.close()
  }
})
