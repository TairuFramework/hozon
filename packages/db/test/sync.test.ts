import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import {
  HozonDB,
  KeyLockScopeError,
  type Kysely,
  type StoreContext,
  sql,
  withKeyLock,
  withKeyLocks,
} from '../src/index.js'

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
          [sp, sp, sp].map((provider) =>
            withKeyLock(provider, 'items', ['a'], async (locked) => {
              expect(locked.transactionRoot).toBe(tx)
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
      for (const key of ['a', 'b']) {
        expect(await withKeyLock(tx, 'items', [key], async () => 'released')).toBe('released')
      }
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

test('lock ownership follows the callback provider and derived providers', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      await withKeyLock(tx, 'items', ['a'], async (locked) => {
        expect(await withKeyLock(locked, 'items', ['a'], async () => 'nested')).toBe('nested')
        await locked.withTransaction(async (derived) => {
          expect(await withKeyLocks(derived, 'items', [['b'], ['a']], async () => 'added')).toBe(
            'added',
          )
        })
        if (!locked.withScope || !locked.withSavepoint) throw new Error('Missing scopes')
        await locked.withScope(async (derived) => {
          await withKeyLock(derived, 'items', ['a'], async () => {})
        })
        await locked.withSavepoint(async (derived) => {
          await withKeyLock(derived, 'items', ['a'], async () => {})
        })
      })
    })
  } finally {
    await db.close()
  }
}, 2_000)

test('outer-provider siblings wait for the callback owner', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let siblingEntered = false
      const holder = withKeyLock(tx, 'items', ['a'], async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const sibling = withKeyLock(tx, 'items', ['a'], async () => {
        siblingEntered = true
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(siblingEntered).toBe(false)
      } finally {
        release.resolve()
      }
      await Promise.all([holder, sibling])
      expect(siblingEntered).toBe(true)
    })
  } finally {
    await db.close()
  }
}, 2_000)

test.each(['release', 'rollback'])(
  'savepoint key reservations last until %s',
  async (outcome) => {
    const db = setup()
    try {
      await db.withTransaction(async (tx) => {
        if (!tx.withSavepoint) throw new Error('Missing savepoints')
        const ready = Promise.withResolvers<void>()
        const settle = Promise.withResolvers<void>()
        const savepoint = tx.withSavepoint(async (sp) => {
          await withKeyLock(sp, 'items', ['a'], async () => {})
          ready.resolve()
          await settle.promise
          if (outcome === 'rollback') throw new Error('rollback')
        })
        const result = savepoint.catch((error: unknown) => error)
        await ready.promise
        try {
          await expect(withKeyLock(tx, 'items', ['a'], async () => {})).rejects.toBeInstanceOf(
            KeyLockScopeError,
          )
        } finally {
          settle.resolve()
          await result
        }
        let siblingEntered = false
        let sibling: Promise<void> | undefined
        await withKeyLock(tx, 'items', ['a'], async () => {
          sibling = withKeyLock(tx, 'items', ['a'], async () => {
            siblingEntered = true
          })
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
          expect(siblingEntered).toBe(false)
        })
        await sibling
        expect(siblingEntered).toBe(true)
      })
    } finally {
      await db.close()
    }
  },
  2_000,
)

test('withKeyLocks releases both queues after SQL acquisition fails', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      await expect(withKeyLocks(tx, 'missing', [['a'], ['b']], async () => {})).rejects.toThrow(
        'no such table',
      )
      const query = (await tx.getStore('sync')) as { query: Kysely<Record<string, unknown>> }
      await query.query.schema.createTable('missing').addColumn('id', 'text').execute()
      for (const key of ['a', 'b']) {
        await withKeyLock(tx, 'missing', [key], async () => {})
      }
    })
  } finally {
    await db.close()
  }
}, 2_000)

test('lock-scoped providers share their savepoint overlap guard', async () => {
  const db = setup()
  try {
    await db.withTransaction(async (tx) => {
      await withKeyLock(tx, 'items', ['a'], async (locked) => {
        if (!locked.withSavepoint) throw new Error('Missing savepoints')
        await locked.withSavepoint(async () => {
          if (!tx.withSavepoint) throw new Error('Missing savepoints')
          await expect(tx.withSavepoint(async () => {})).rejects.toMatchObject({
            name: 'SavepointOverlapError',
          })
        })
      })
    })
  } finally {
    await db.close()
  }
}, 2_000)
