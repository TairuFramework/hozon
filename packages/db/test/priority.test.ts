import { DatabaseSync } from 'node:sqlite'
import { AbstractSQLiteAdapter, type WritePriority } from '@hozon/adapter'
import {
  type DatabaseConnection,
  type Dialect,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import { expect, test } from 'vitest'

import { HozonDB } from '../src/db.js'

class PriorityDialectAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true
  }
}

// Only model priority admission here; driver fairness and FIFO belong in Expo's tests.
class MemoryAdapter extends AbstractSQLiteAdapter {
  #database = new DatabaseSync(':memory:')
  #held = false
  #waiting: Record<WritePriority, Array<() => void>> = { high: [], low: [] }
  #connection: DatabaseConnection = {
    async executeQuery() {
      throw new Error('This transaction-only test does not execute queries')
    },
    streamQuery() {
      throw new Error('This transaction-only test does not stream queries')
    },
  }
  #closed = false

  get dialect(): Dialect {
    return this.transactionDialect('high')
  }

  transactionDialect(priority: WritePriority): Dialect {
    return {
      createAdapter: () => new PriorityDialectAdapter(),
      createQueryCompiler: () => new SqliteQueryCompiler(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => {
          if (this.#held) {
            await new Promise<void>((resolve) => this.#waiting[priority].push(resolve))
          } else {
            this.#held = true
          }
          return this.#connection
        },
        beginTransaction: async () => {
          this.#database.exec('BEGIN')
        },
        commitTransaction: async () => {
          this.#database.exec('COMMIT')
        },
        rollbackTransaction: async () => {
          this.#database.exec('ROLLBACK')
        },
        releaseConnection: async () => {
          const next = this.#waiting.high.shift() ?? this.#waiting.low.shift()
          if (next) next()
          else this.#held = false
        },
        destroy: async () => {},
      }),
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) this.#database.close()
    this.#closed = true
  }
}

test('transaction priority views share one queue and release before commit hooks', async () => {
  const db = new HozonDB({ adapter: new MemoryAdapter() })
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: Array<string> = []
  try {
    const holder = db.withTransaction(async (tx) => {
      tx.onCommit(() => order.push('commit'))
      held.resolve()
      await release.promise
    })
    await held.promise
    const low = db.withTransaction(
      async () => {
        order.push('low')
      },
      { priority: 'low' },
    )
    const high = db.withTransaction(async () => {
      order.push('high')
    })
    expect(order).toEqual([])
    // Let both Kysely drivers reach their shared connection queue.
    await new Promise<void>((resolve) => setImmediate(resolve))
    release.resolve()
    await Promise.all([holder, low, high])
    expect(order).toEqual(['commit', 'high', 'low'])
  } finally {
    release.resolve()
    await db.close()
  }
})
