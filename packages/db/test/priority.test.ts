import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { SQLiteDatabase } from 'expo-sqlite'
import { expect, test } from 'vitest'

import { AbstractSQLiteAdapter } from '../../adapter/src/index.js'
import type { WritePriority } from '../../adapter/src/types.js'
import { ConnectionMutex, ExpoDialect } from '../../expo/src/driver.js'
import { HozonDB } from '../src/db.js'

// Exercise the Expo connection protocol against real SQLite without a device.
class MemoryAdapter extends AbstractSQLiteAdapter {
  #database = new DatabaseSync(':memory:')
  #mutex = new ConnectionMutex()
  #closed = false

  get dialect(): ExpoDialect {
    return this.transactionDialect('high')
  }

  transactionDialect(priority: WritePriority): ExpoDialect {
    const database = {
      getAllAsync: async (query: string, values: Array<SQLInputValue>) =>
        this.#database.prepare(query).all(...values),
      runAsync: async (query: string, values: Array<SQLInputValue>) => {
        const result = this.#database.prepare(query).run(...values)
        return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) }
      },
    } as unknown as SQLiteDatabase
    return new ExpoDialect({ database, priority, mutex: this.#mutex, destroy: async () => {} })
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
