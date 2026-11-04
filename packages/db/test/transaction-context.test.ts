import type { Adapter } from '@hozon/adapter'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test, vi } from 'vitest'

import { HozonDB, type TransactionContext, TransactionScopeError } from '../src/index.js'

function fakeContext() {
  let active = false
  const context = {
    active: vi.fn(() => active),
    async run<R>(fn: () => Promise<R>): Promise<R> {
      active = true
      try {
        return await fn()
      } finally {
        active = false
      }
    },
  }
  return context
}

function createDB(context?: TransactionContext) {
  const adapter: Adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  Object.defineProperty(adapter, 'transactionContext', { value: context })
  return new HozonDB({ adapter })
}

test('injected context detects root calls and permits transaction-bound nesting', async () => {
  const context = fakeContext()
  const db = createDB(context)
  try {
    await db.withTransaction(async (tx) => {
      expect(context.active()).toBe(true)
      await expect(db.withTransaction(async () => {})).rejects.toBeInstanceOf(TransactionScopeError)
      expect(await tx.withTransaction(async (inner) => inner === tx)).toBe(true)
    })
    expect(context.active()).toBe(false)
  } finally {
    await db.close()
  }
})

test.each([false, true])('context settles after the callback (rollback: %s)', async (rollback) => {
  const context = fakeContext()
  const db = createDB(context)
  try {
    const result = db.withTransaction(async () => {
      expect(context.active()).toBe(true)
      if (rollback) throw new Error('rollback')
      return 'done'
    })
    if (rollback) await expect(result).rejects.toThrow('rollback')
    else await expect(result).resolves.toBe('done')
    expect(context.active()).toBe(false)
    await expect(db.withTransaction(async () => 'next')).resolves.toBe('next')
  } finally {
    await db.close()
  }
})

test('without context root calls queue instead of detecting caller nesting', async () => {
  const db = createDB()
  let nested: Promise<string> | undefined
  try {
    await db.withTransaction(async (tx) => {
      expect(await tx.withTransaction(async (inner) => inner === tx)).toBe(true)
      nested = db.withTransaction(async () => 'queued')
    })
    await expect(nested).resolves.toBe('queued')
  } finally {
    await db.close()
  }
})

test('unrelated callers queue when the injected context reports them outside the transaction', async () => {
  const context = fakeContext()
  const db = createDB(context)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: Array<string> = []
  try {
    const first = db.withTransaction(async () => {
      order.push('first')
      started.resolve()
      await release.promise
      order.push('released')
    })
    await started.promise
    // Model a separate async task without requiring an async-context runtime in this fake.
    context.active.mockReturnValueOnce(false)
    const second = db.withTransaction(async () => order.push('second'))
    release.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'released', 'second'])
  } finally {
    release.resolve()
    await db.close()
  }
})

test('migration callbacks run in the injected context', async () => {
  const context = fakeContext()
  const db = createDB(context)
  db.register({
    name: 'context',
    migrations: {
      '0-init': {
        async up() {
          expect(context.active()).toBe(true)
          await expect(db.withTransaction(async () => {})).rejects.toBeInstanceOf(
            TransactionScopeError,
          )
        },
      },
    },
    createAPI: () => ({}),
  })
  try {
    await db.migrate()
    expect(context.active()).toBe(false)
  } finally {
    await db.close()
  }
})

test('multi-connection adapters do not reject based on active context', async () => {
  const context = fakeContext()
  const adapter: Adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  Object.defineProperties(adapter, {
    kind: { value: 'postgres' },
    transactionContext: { value: context },
  })
  const db = new HozonDB({ adapter })
  try {
    context.active.mockReturnValue(true)
    await expect(db.withTransaction(async () => 'done')).resolves.toBe('done')
  } finally {
    await db.close()
  }
})

test('root transactions reject in the active caller context', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let nested: Promise<unknown> | undefined
  let observed: unknown
  await db.withTransaction(async () => {
    await Promise.resolve()
    nested = db.withTransaction(async () => 'unexpected')
    observed = await Promise.race([
      nested.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('queued'), 30)),
    ])
  })
  await nested?.catch(() => {})
  await db.close()
  expect(observed).toBeInstanceOf(TransactionScopeError)
})

test('transaction-bound calls run inline and external scopes reject root nesting', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  let nested: Promise<unknown> | undefined
  let observed: unknown
  await db.withScope(async (scope) => {
    await scope.withTransaction(async (tx) => {
      expect(await tx.withTransaction(async (inner) => inner === tx)).toBe(true)
      nested = scope.withTransaction(async () => 'unexpected')
      observed = await Promise.race([
        nested.catch((error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('queued'), 30)),
      ])
    })
  })
  await nested?.catch(() => {})
  await db.close()
  expect(observed).toBeInstanceOf(TransactionScopeError)
})

test('unrelated callers queue while a transaction owns the connection', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let secondStarted = false
  const first = db.withTransaction(async () => {
    started.resolve()
    await release.promise
  })
  await started.promise
  const second = db.withTransaction(async () => {
    secondStarted = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(secondStarted).toBe(false)
  release.resolve()
  await Promise.all([first, second])
  expect(secondStarted).toBe(true)
  await db.close()
})

test.each([false, true])(
  'inherited context becomes inactive after settlement (rollback: %s)',
  async (rollback) => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    const release = Promise.withResolvers<void>()
    let inherited: Promise<unknown> | undefined
    const transaction = db.withTransaction(async () => {
      inherited = release.promise.then(async () => db.withTransaction(async () => 'done'))
      if (rollback) throw new Error('rollback')
    })
    if (rollback) await expect(transaction).rejects.toThrow('rollback')
    else await transaction
    release.resolve()
    await expect(inherited).resolves.toBe('done')
    await db.close()
  },
)
