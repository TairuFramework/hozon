import type { Adapter } from '@hozon/adapter'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { Kysely } from 'kysely'
import { describe, expect, test } from 'vitest'

import { HozonDB, SavepointOverlapError, withStoreTransaction } from '../src/index.js'

type ItemsAPI = {
  insert(id: string, value: string): Promise<void>
  get(id: string): Promise<{ id: string; value: string } | undefined>
}

type LogsAPI = {
  insert(id: string, message: string): Promise<void>
  list(): Promise<Array<{ id: string; message: string }>>
}

function createTestDB(adapter: Adapter = new NodeSQLiteAdapter({ database: ':memory:' })) {
  const db = new HozonDB({ adapter })

  db.register<{ test_items: { id: string; value: string } }, ItemsAPI>({
    name: 'items',
    migrations: {
      '0-init': {
        async up(db: Kysely<Record<string, unknown>>) {
          await db.schema
            .createTable('test_items')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('value', 'text', (col) => col.notNull())
            .execute()
        },
        async down() {},
      },
    },
    createAPI: (db) => ({
      async insert(id: string, value: string) {
        await db.insertInto('test_items').values({ id, value }).execute()
      },
      async get(id: string) {
        return db
          .selectFrom('test_items')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst() as Promise<{ id: string; value: string } | undefined>
      },
    }),
  })

  db.register<{ test_logs: { id: string; message: string } }, LogsAPI>({
    name: 'logs',
    migrations: {
      '0-init': {
        async up(db: Kysely<Record<string, unknown>>) {
          await db.schema
            .createTable('test_logs')
            .addColumn('id', 'text', (col) => col.primaryKey())
            .addColumn('message', 'text', (col) => col.notNull())
            .execute()
        },
        async down() {},
      },
    },
    createAPI: (db) => ({
      async insert(id: string, message: string) {
        await db
          .insertInto('test_logs' as never)
          .values({ id, message } as never)
          .execute()
      },
      async list() {
        return db
          .selectFrom('test_logs' as never)
          .selectAll()
          .execute() as Promise<Array<{ id: string; message: string }>>
      },
    }),
  })

  return db
}

describe('HozonDB.withTransaction', () => {
  test('cross-store transaction commits atomically', async () => {
    const db = createTestDB()

    await db.withTransaction<{ items: ItemsAPI; logs: LogsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      const logs = await tx.getStore('logs')
      await items.insert('a', 'hello')
      await logs.insert('log1', 'created a')
    })

    const items = await db.getStore<ItemsAPI>('items')
    const logs = await db.getStore<LogsAPI>('logs')
    expect(await items.get('a')).toEqual({ id: 'a', value: 'hello' })
    expect(await logs.list()).toHaveLength(1)
    await db.close()
  })

  test('cross-store transaction rolls back on error', async () => {
    const db = createTestDB()

    await expect(
      db.withTransaction<{ items: ItemsAPI; logs: LogsAPI }, void>(async (tx) => {
        const items = await tx.getStore('items')
        await items.insert('b', 'world')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('b')).toBeUndefined()
    await db.close()
  })

  test('onCommit hooks run after successful commit', async () => {
    const db = createTestDB()
    const hooks: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      tx.onCommit(() => hooks.push('committed'))
      const items = await tx.getStore('items')
      await items.insert('c', 'test')
    })

    expect(hooks).toEqual(['committed'])
    await db.close()
  })

  test('a throwing commit hook does not stop later hooks or fail the transaction', async () => {
    const db = createTestDB()
    const ran: Array<string> = []

    const result = await db.withTransaction<{ items: ItemsAPI }, string>(async (tx) => {
      tx.onCommit(() => {
        ran.push('first')
        throw new Error('hook boom')
      })
      tx.onCommit(() => {
        ran.push('second')
      })
      const items = await tx.getStore('items')
      await items.insert('hook', 'kept')
      return 'committed'
    })

    // First hook threw, but the second still ran and the committed result is returned.
    expect(ran).toEqual(['first', 'second'])
    expect(result).toBe('committed')

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('hook')).toEqual({ id: 'hook', value: 'kept' })
    await db.close()
  })

  test('onCommit hooks do not run on rollback', async () => {
    const db = createTestDB()
    const hooks: Array<string> = []

    await expect(
      db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
        tx.onCommit(() => hooks.push('should not run'))
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')

    expect(hooks).toEqual([])
    await db.close()
  })

  test('concurrent withTransaction calls both commit', async () => {
    const db = createTestDB()

    const [r1, r2] = await Promise.all([
      db.withTransaction<{ items: ItemsAPI }, string>(async (tx) => {
        const items = await tx.getStore('items')
        await items.insert('c1', 'first')
        return 'first'
      }),
      db.withTransaction<{ items: ItemsAPI }, string>(async (tx) => {
        const items = await tx.getStore('items')
        await items.insert('c2', 'second')
        return 'second'
      }),
    ])

    expect([r1, r2].sort()).toEqual(['first', 'second'])
    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('c1')).toEqual({ id: 'c1', value: 'first' })
    expect(await items.get('c2')).toEqual({ id: 'c2', value: 'second' })
    await db.close()
  })

  test('concurrent withTransaction: one rolls back, other commits', async () => {
    const db = createTestDB()

    const success = db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      await items.insert('ok', 'kept')
    })

    const failure = db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      await items.insert('nope', 'discarded')
      throw new Error('rollback')
    })

    await success
    await expect(failure).rejects.toThrow('rollback')

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('ok')).toEqual({ id: 'ok', value: 'kept' })
    expect(await items.get('nope')).toBeUndefined()
    await db.close()
  })

  test('read-your-own-writes inside transaction', async () => {
    const db = createTestDB()

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      await items.insert('d', 'visible')
      const row = await items.get('d')
      expect(row).toEqual({ id: 'd', value: 'visible' })
    })

    await db.close()
  })

  test('cold start — migrations run before transaction starts', async () => {
    const db = createTestDB()
    // No getStore calls before — stores not yet migrated

    await db.withTransaction<{ items: ItemsAPI; logs: LogsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      const logs = await tx.getStore('logs')
      await items.insert('e', 'cold')
      await logs.insert('log2', 'cold start')
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('e')).toEqual({ id: 'e', value: 'cold' })
    await db.close()
  })
})

describe('HozonDB.onCommit', () => {
  test('fires immediately outside transaction', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    const hooks: Array<string> = []
    db.onCommit(() => hooks.push('fired'))
    expect(hooks).toEqual(['fired'])
    await db.close()
  })
})

describe('HozonDB.withSavepoint', () => {
  const create = () => new NodeSQLiteAdapter({ database: ':memory:' })

  test('overlapping sibling savepoint is rejected without touching the open one', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      const withSavepoint = tx.withSavepoint.bind(tx)
      const first = withSavepoint<{ items: ItemsAPI }, void>(async (scope) => {
        const items = await scope.getStore('items')
        await items.insert('first', 'kept')
        scope.onCommit(() => fired.push('first'))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      const second = withSavepoint<{ items: ItemsAPI }, void>(async (scope) => {
        await (await scope.getStore('items')).insert('second', 'never')
      })
      await expect(second).rejects.toBeInstanceOf(SavepointOverlapError)
      await first
      await withSavepoint<{ items: ItemsAPI }, void>(async (scope) => {
        await (await scope.getStore('items')).insert('third', 'kept')
      })
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('first')).toEqual({ id: 'first', value: 'kept' })
    expect(await items.get('second')).toBeUndefined()
    expect(await items.get('third')).toEqual({ id: 'third', value: 'kept' })
    expect(fired).toEqual(['first'])
    await db.close()
  })

  test('savepoint opened through the parent provider from inside a savepoint rejects instead of hanging', async () => {
    const db = createTestDB(await create())

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      const withSavepoint = tx.withSavepoint.bind(tx)
      await expect(
        withSavepoint<{ items: ItemsAPI }, void>(async () => {
          await withSavepoint<{ items: ItemsAPI }, void>(async () => {})
        }),
      ).rejects.toBeInstanceOf(SavepointOverlapError)
    })
    await db.close()
  })

  test('nested savepoint finishes while its parent is active', async () => {
    const db = createTestDB(await create())
    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await tx.withSavepoint<{ items: ItemsAPI }, void>(async (outer) => {
        if (!outer.withSavepoint) throw new Error('nested savepoints unavailable')
        await outer.withSavepoint<{ items: ItemsAPI }, void>(async (inner) => {
          await (await inner.getStore('items')).insert('nested', 'kept')
        })
      })
    })
    expect(await (await db.getStore<ItemsAPI>('items')).get('nested')).toEqual({
      id: 'nested',
      value: 'kept',
    })
    await db.close()
  })

  test('savepoint rollback runs every hook and preserves the original error', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []
    const original = new Error('original failure')
    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await expect(
        tx.withSavepoint(async (scope) => {
          scope.onRollback(() => {
            fired.push('first')
            throw new Error('hook failure')
          })
          scope.onRollback(() => fired.push('second'))
          throw original
        }),
      ).rejects.toBe(original)
      await (await tx.getStore('items')).insert('after-hooks', 'kept')
    })
    expect(fired).toEqual(['first', 'second'])
    expect(await (await db.getStore<ItemsAPI>('items')).get('after-hooks')).toEqual({
      id: 'after-hooks',
      value: 'kept',
    })
    await db.close()
  })

  test('SQL statement failure inside a savepoint leaves the outer transaction usable', async () => {
    const db = createTestDB(await create())
    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      const items = await tx.getStore('items')
      await items.insert('duplicate', 'original')
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await expect(
        tx.withSavepoint<{ items: ItemsAPI }, void>(async (scope) => {
          const scopedItems = await scope.getStore('items')
          await scopedItems.insert('discarded', 'discarded')
          await scopedItems.insert('duplicate', 'violates primary key')
        }),
      ).rejects.toThrow()
      await items.insert('after-sql-error', 'kept')
    })
    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('duplicate')).toEqual({ id: 'duplicate', value: 'original' })
    expect(await items.get('discarded')).toBeUndefined()
    expect(await items.get('after-sql-error')).toEqual({ id: 'after-sql-error', value: 'kept' })
    await db.close()
  })

  test('released savepoint keeps writes and delays commit hooks until outer commit', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await tx.withSavepoint<{ items: ItemsAPI }, void>(async (savepoint) => {
        const items = await savepoint.getStore('items')
        await items.insert('released', 'kept')
        savepoint.onCommit(() => fired.push('commit'))
      })
      expect(fired).toEqual([])
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('released')).toEqual({ id: 'released', value: 'kept' })
    expect(fired).toEqual(['commit'])
    await db.close()
  })

  test('throwing savepoint rolls back its writes and hooks while outer transaction commits', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      const items = await tx.getStore('items')
      await items.insert('before', 'kept')
      await expect(
        tx.withSavepoint<{ items: ItemsAPI }, void>(async (savepoint) => {
          const scopedItems = await savepoint.getStore('items')
          await scopedItems.insert('failed', 'discarded')
          savepoint.onCommit(() => fired.push('savepoint-commit'))
          savepoint.onRollback(() => fired.push('savepoint-rollback'))
          throw new Error('savepoint failed')
        }),
      ).rejects.toThrow('savepoint failed')
      expect(fired).toEqual(['savepoint-rollback'])
      await items.insert('after', 'kept')
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('before')).toEqual({ id: 'before', value: 'kept' })
    expect(await items.get('failed')).toBeUndefined()
    expect(await items.get('after')).toEqual({ id: 'after', value: 'kept' })
    expect(fired).toEqual(['savepoint-rollback'])
    await db.close()
  })

  test('nested withTransaction commit hook does not escape a rolled-back savepoint', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await expect(
        tx.withSavepoint<{ items: ItemsAPI }, void>(async (savepoint) => {
          await savepoint.withTransaction<{ items: ItemsAPI }, void>(async (nested) => {
            const items = await nested.getStore('items')
            await items.insert('nested-transaction', 'discarded')
            nested.onCommit(() => fired.push('nested-commit'))
            nested.onRollback(() => fired.push('nested-rollback'))
          })
          throw new Error('outer savepoint failed')
        }),
      ).rejects.toThrow('outer savepoint failed')
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('nested-transaction')).toBeUndefined()
    expect(fired).toEqual(['nested-rollback'])
    await db.close()
  })

  test('nested savepoint rollback preserves the enclosing savepoint writes', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await tx.withSavepoint<{ items: ItemsAPI }, void>(async (outer) => {
        if (!outer.withSavepoint) throw new Error('nested savepoints unavailable')
        const items = await outer.getStore('items')
        await items.insert('outer', 'kept')
        await expect(
          outer.withSavepoint<{ items: ItemsAPI }, void>(async (inner) => {
            const innerItems = await inner.getStore('items')
            await innerItems.insert('inner-failed', 'discarded')
            inner.onRollback(() => fired.push('inner-rollback'))
            throw new Error('inner failed')
          }),
        ).rejects.toThrow('inner failed')
        expect(await items.get('outer')).toEqual({ id: 'outer', value: 'kept' })
        expect(await items.get('inner-failed')).toBeUndefined()
      })
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('outer')).toEqual({ id: 'outer', value: 'kept' })
    expect(await items.get('inner-failed')).toBeUndefined()
    expect(fired).toEqual(['inner-rollback'])
    await db.close()
  })

  test('enclosing savepoint rollback discards released inner writes and commit hooks', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      if (!tx.withSavepoint) throw new Error('savepoints unavailable')
      await expect(
        tx.withSavepoint<{ items: ItemsAPI }, void>(async (outer) => {
          if (!outer.withSavepoint) throw new Error('nested savepoints unavailable')
          const items = await outer.getStore('items')
          await items.insert('outer-failed', 'discarded')
          await outer.withSavepoint<{ items: ItemsAPI }, void>(async (inner) => {
            const innerItems = await inner.getStore('items')
            await innerItems.insert('inner-released', 'discarded')
            inner.onCommit(() => fired.push('inner-commit'))
            inner.onRollback(() => fired.push('inner-rollback'))
          })
          expect(fired).toEqual([])
          throw new Error('outer failed')
        }),
      ).rejects.toThrow('outer failed')
      expect(fired).toEqual(['inner-rollback'])
    })

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('outer-failed')).toBeUndefined()
    expect(await items.get('inner-released')).toBeUndefined()
    expect(fired).toEqual(['inner-rollback'])
    await db.close()
  })

  test('outer transaction rollback runs released savepoint rollback hooks only', async () => {
    const db = createTestDB(await create())
    const fired: Array<string> = []

    await expect(
      db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
        if (!tx.withSavepoint) throw new Error('savepoints unavailable')
        await tx.withSavepoint<{ items: ItemsAPI }, void>(async (savepoint) => {
          const items = await savepoint.getStore('items')
          await items.insert('released-then-rolled-back', 'discarded')
          savepoint.onCommit(() => fired.push('commit'))
          savepoint.onRollback(() => fired.push('rollback'))
        })
        expect(fired).toEqual([])
        throw new Error('outer transaction failed')
      }),
    ).rejects.toThrow('outer transaction failed')

    const items = await db.getStore<ItemsAPI>('items')
    expect(await items.get('released-then-rolled-back')).toBeUndefined()
    expect(fired).toEqual(['rollback'])
    await db.close()
  })
})

describe('HozonDB.onRollback', () => {
  test('rollback hook fires and commit hook does not when the callback throws', async () => {
    const db = createTestDB()
    const fired: Array<string> = []

    await expect(
      db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
        tx.onCommit(() => fired.push('commit'))
        tx.onRollback(() => fired.push('rollback'))
        const items = await tx.getStore('items')
        await items.insert('r', 'temp')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(fired).toEqual(['rollback'])
    await db.close()
  })

  test('rollback hook observes the DB already reverted', async () => {
    const db = createTestDB()
    let observed: { id: string; value: string } | undefined | 'unset' = 'unset'
    let readDone: Promise<void> | undefined

    await expect(
      db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
        const items = await tx.getStore('items')
        await items.insert('reverted', 'temp')
        tx.onRollback(() => {
          // The DB is already rolled back; a fresh non-tx read must miss the row.
          readDone = db.getStore<ItemsAPI>('items').then(async (store) => {
            observed = await store.get('reverted')
          })
        })
        throw new Error('rollback please')
      }),
    ).rejects.toThrow('rollback please')

    await readDone
    expect(observed).toBeUndefined()
    await db.close()
  })

  test('nested onRollback fires when the outer transaction rolls back', async () => {
    const db = createTestDB()
    const fired: Array<string> = []

    await expect(
      db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
        await tx.withTransaction<{ items: ItemsAPI }, void>(async (inner) => {
          inner.onRollback(() => fired.push('inner-rollback'))
        })
        throw new Error('outer boom')
      }),
    ).rejects.toThrow('outer boom')

    expect(fired).toEqual(['inner-rollback'])
    await db.close()
  })

  test('onRollback is a no-op outside a transaction', async () => {
    const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    let called = false
    db.onRollback(() => {
      called = true
    })
    expect(called).toBe(false)
    await db.close()
  })

  test('a successful commit fires onCommit and not onRollback', async () => {
    const db = createTestDB()
    const fired: Array<string> = []

    await db.withTransaction<{ items: ItemsAPI }, void>(async (tx) => {
      tx.onCommit(() => fired.push('commit'))
      tx.onRollback(() => fired.push('rollback'))
      const items = await tx.getStore('items')
      await items.insert('ok', 'kept')
    })

    expect(fired).toEqual(['commit'])
    await db.close()
  })
})

describe('withStoreTransaction', () => {
  test('root opens a transaction and nested calls run inline', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const db = new Kysely<{ items: { id: string } }>({ dialect: adapter.dialect })
    await db.schema.createTable('items').addColumn('id', 'text').execute()
    const value = await withStoreTransaction(db, async (trx) => {
      expect(trx.isTransaction).toBe(true)
      return withStoreTransaction(trx, async (nested) => {
        expect(nested).toBe(trx)
        await nested.insertInto('items').values({ id: 'kept' }).execute()
        return 42
      })
    })
    expect(value).toBe(42)
    await expect(
      withStoreTransaction(db, async (trx) => {
        await trx.insertInto('items').values({ id: 'rolled-back' }).execute()
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ id: 'kept' }])
    await db.destroy()
  })
})
