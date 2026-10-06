import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { expect, test } from 'vitest'

import { HozonDB } from '../src/index.js'

type Tables = Record<string, unknown>

test('a failed SQLite migration rolls back its DDL and retries cleanly', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
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
    expect(tables).not.toContain('flaky_items')

    const query = await db.getStore<Kysely<Tables>>('flaky')
    expect(attempts).toBe(2)
    expect((await query.introspection.getTables()).map((table) => table.name)).toContain(
      'flaky_items',
    )
    const migrations = query as unknown as Kysely<{ hozon_flaky_migration: { name: string } }>
    expect(await migrations.selectFrom('hozon_flaky_migration').select('name').execute()).toEqual([
      { name: '0-init' },
    ])
  } finally {
    await db.close()
  }
})
