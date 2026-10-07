import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { expect, test } from 'vitest'

import { HozonDB } from '../src/index.js'

type Tables = Record<string, unknown>

test('a failed SQLite migration rolls back its DDL and retries cleanly', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new HozonDB({ adapter })
  let attempts = 0
  db.register<Tables, Kysely<Tables>>({
    name: 'flaky',
    migrations: {
      '0-init': {
        async up(query) {
          attempts++
          // No `ifNotExists`: a leftover table from the failed attempt would break the retry.
          await query.schema.createTable('flaky_items').addColumn('id', 'integer').execute()
          if (attempts === 1) throw new Error('migration failed after DDL')
        },
      },
    },
    createAPI: (query) => query,
  })
  db.register<Tables, Kysely<Tables>>({ name: 'raw', migrations: {}, createAPI: (query) => query })
  try {
    await expect(db.getStore('flaky')).rejects.toThrow('migration failed after DDL')
    const raw = await db.getStore<Kysely<Tables>>('raw')
    const tables = (await raw.introspection.getTables()).map((table) => table.name)
    expect(tables).not.toContain('hozon_flaky_items')

    const query = await db.getStore<Kysely<Tables>>('flaky')
    expect(attempts).toBe(2)
    expect((await query.introspection.getTables()).map((table) => table.name)).toContain(
      'hozon_flaky_items',
    )
    expect(adapter.database.prepare('SELECT name FROM hozon_flaky_migration').all()).toEqual([
      { name: '0-init' },
    ])
  } finally {
    await db.close()
  }
})
