import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { getLogger } from '@sozai/log'
import { expect, test, vi } from 'vitest'

import { type BaseStoreContext, HozonDB, sql } from '../src/index.js'

test('onClose hooks run before the adapter closes', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  const events: Array<string> = []
  const close = vi.spyOn(adapter, 'close')
  db.register({
    name: 'close',
    migrations: {},
    createAPI: (storeDB, _adapter, context) => {
      context.onClose(async () => {
        expect(adapter.database.isOpen).toBe(true)
        expect(close).not.toHaveBeenCalled()
        const result = await sql<{ value: number }>`select 1 as value`.execute(storeDB)
        expect(result.rows).toEqual([{ value: 1 }])
        events.push('first')
      })
      context.onClose(() => {
        events.push('second')
      })
      return context
    },
  })
  try {
    await db.getStore('close')
    await Promise.all([db.close(), db.close()])
    await db.close()
    expect(events).toEqual(['first', 'second'])
    expect(close).toHaveBeenCalledOnce()
    expect(adapter.database.isOpen).toBe(false)
  } finally {
    await db.close()
    close.mockRestore()
  }
})

test('a failing onClose hook does not block close', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const logger = getLogger(['hozon', 'test', 'close'])
  const errorLog = vi.spyOn(logger, 'error')
  const db = new HozonDB({ adapter, logger })
  db.register({ name: 'close', migrations: {}, createAPI: (_db, _adapter, context) => context })
  const events: Array<string> = []
  const syncError = new Error('sync failure')
  const asyncError = new Error('async failure')
  try {
    const context = await db.getStore<BaseStoreContext>('close')
    context.onClose(() => {
      events.push('sync')
      throw syncError
    })
    context.onClose(async () => {
      events.push('async')
      throw asyncError
    })
    context.onClose(() => {
      events.push('last')
    })
    await expect(db.close()).resolves.toBeUndefined()
    expect(events).toEqual(['sync', 'async', 'last'])
    expect(errorLog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: syncError }),
    )
    expect(errorLog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: asyncError }),
    )
    expect(adapter.database.isOpen).toBe(false)
  } finally {
    await db.close()
    errorLog.mockRestore()
  }
})

test('onClose registered from a transaction-scoped API still runs once', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let closed = 0
  db.register({
    name: 'close',
    migrations: {},
    createAPI: (_db, _adapter, context) => {
      context.onClose(() => {
        closed++
      })
      return context
    },
  })
  try {
    await db.withTransaction<{ close: BaseStoreContext }, void>(async (tx) => {
      const api = await tx.getStore('close')
      expect(await tx.getStore('close')).toBe(api)
    })
    expect(closed).toBe(0)
    await Promise.all([db.close(), db.close()])
    await db.close()
    expect(closed).toBe(1)
  } finally {
    await db.close()
  }
})
