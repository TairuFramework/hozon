import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { PostgresAdapter } from '@hozon/postgres'
import { describe, expect, test } from 'vitest'

import { resolveAdapter, resolveDB } from '../src/index.js'

describe('resolveAdapter', () => {
  test('resolves in-memory and file SQLite paths', () => {
    const memory = resolveAdapter(':memory:')
    const file = resolveAdapter('/tmp/hozon.sqlite')
    expect(memory).toBeInstanceOf(NodeSQLiteAdapter)
    expect(file).toBeInstanceOf(NodeSQLiteAdapter)
    return Promise.all([memory.close?.(), file.close?.()])
  })

  test.each(['postgres://user:pass@localhost:5432/db', 'postgresql://user:pass@localhost:5432/db'])(
    'resolves %s to PostgresAdapter',
    async (url) => {
      const adapter = resolveAdapter(url)
      expect(adapter).toBeInstanceOf(PostgresAdapter)
      await adapter.close?.()
    },
  )

  test('passes through an existing adapter', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    expect(resolveAdapter(adapter)).toBe(adapter)
    await adapter.close()
  })
})

describe('resolveDB', () => {
  test('passes through an existing HozonDB', async () => {
    const existing = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
    expect(resolveDB(existing)).toBe(existing)
    await existing.close()
  })

  test('wraps an existing adapter', async () => {
    const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
    const db = resolveDB(adapter)
    expect(db).toBeInstanceOf(HozonDB)
    await db.close()
  })

  test('resolves a connection string', async () => {
    const db = resolveDB(':memory:')
    expect(db).toBeInstanceOf(HozonDB)
    await db.close()
  })
})
