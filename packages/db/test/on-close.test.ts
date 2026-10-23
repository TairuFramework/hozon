import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { getLogger } from '@sozai/log'
import { expect, test, vi } from 'vitest'

import { type BaseStoreContext, HozonDB, HozonDBClosedError, sql } from '../src/index.js'

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

test('transaction getStore rejects once close starts, including cached APIs', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  const gate = Promise.withResolvers<void>()
  let closing: Promise<void> | undefined
  for (const name of ['cached', 'fresh']) {
    db.register({ name, migrations: {}, createAPI: (_db, _adapter, context) => context })
  }
  try {
    await db.withTransaction<{ cached: BaseStoreContext; fresh: BaseStoreContext }, void>(
      async (tx) => {
        const context = await tx.getStore('cached')
        context.onClose(() => gate.promise)
        closing = db.close()
        const results = await Promise.allSettled([tx.getStore('cached'), tx.getStore('fresh')])
        for (const result of results) {
          expect(result.status).toBe('rejected')
          if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(HozonDBClosedError)
        }
      },
    )
  } finally {
    gate.resolve()
    await (closing ?? db.close())
  }
})

test('captured context rejects onClose registration once close starts', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register({ name: 'close', migrations: {}, createAPI: (_db, _adapter, context) => context })
  const gate = Promise.withResolvers<void>()
  try {
    const context = await db.getStore<BaseStoreContext>('close')
    context.onClose(() => gate.promise)
    const closing = db.close()
    try {
      expect(() => context.onClose(() => {})).toThrow(HozonDBClosedError)
    } finally {
      gate.resolve()
      await closing
    }
    expect(() => context.onClose(() => {})).toThrow(HozonDBClosedError)
  } finally {
    gate.resolve()
    await db.close()
  }
})

test('re-entrant close shares its promise and runs hooks and destroy once', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const driver = adapter.dialect.createDriver()
  const createDriver = vi.spyOn(adapter.dialect, 'createDriver').mockReturnValue(driver)
  const destroy = vi.spyOn(driver, 'destroy')
  const adapterClose = vi.spyOn(adapter, 'close')
  const db = new HozonDB({ adapter })
  db.register({ name: 'close', migrations: {}, createAPI: (_db, _adapter, context) => context })
  const events: Array<string> = []
  let reentrant: Promise<void> | undefined
  try {
    const context = await db.getStore<BaseStoreContext>('close')
    context.onClose(() => {
      events.push('first')
      if (events.length === 1) reentrant = db.close()
    })
    context.onClose(() => {
      events.push('second')
    })
    const closing = db.close()
    await closing
    await reentrant
    expect(reentrant).toBe(closing)
    expect(events).toEqual(['first', 'second'])
    expect(destroy).toHaveBeenCalledOnce()
    expect(adapterClose).toHaveBeenCalledOnce()
    expect(adapter.database.isOpen).toBe(false)
  } finally {
    await db.close()
    createDriver.mockRestore()
    destroy.mockRestore()
    adapterClose.mockRestore()
  }
})
