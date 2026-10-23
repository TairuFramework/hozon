import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import type { Kysely } from 'kysely'
import { expect, test } from 'vitest'

import { HozonDB, type StoreDefinition } from '../src/index.js'

type Tables = { items: { id: string } }
type ItemsApi = { count(): Promise<number> }

const definition: StoreDefinition<Tables, ItemsApi> = {
  name: 'items',
  migrations: {
    '0-init': {
      async up(db: Kysely<unknown>) {
        await db.schema
          .createTable('items')
          .addColumn('id', 'text', (col) => col.primaryKey())
          .execute()
      },
    },
  },
  createAPI: (db) => ({
    async count() {
      return (await db.selectFrom('items').select('id').execute()).length
    },
  }),
}

test('an up-to-date store opens while another db holds the connection in a transaction', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const first = new HozonDB({ adapter })
  first.register(definition)
  await first.getStore<ItemsApi>('items')

  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered = () => {}
  const inside = new Promise<void>((resolve) => {
    entered = resolve
  })
  const transaction = first.withTransaction<{ items: ItemsApi }, void>(async (tx) => {
    await (await tx.getStore('items')).count()
    entered()
    await held
  })
  await inside

  const second = new HozonDB({ adapter })
  second.register(definition)
  try {
    const store = await second.getStore<ItemsApi>('items')
    expect(await store.count()).toBe(0)
  } finally {
    release()
    await transaction
    await first.close()
  }
})

test('a store with a pending migration still migrates when earlier ones are applied', async () => {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const first = new HozonDB({ adapter })
  first.register(definition)
  await first.getStore<ItemsApi>('items')

  const second = new HozonDB({ adapter })
  second.register({
    ...definition,
    migrations: {
      ...definition.migrations,
      '1-name': {
        async up(db: Kysely<unknown>) {
          await db.schema.alterTable('items').addColumn('name', 'text').execute()
        },
      },
    },
  })
  try {
    await second.getStore<ItemsApi>('items')
    const columns = adapter.database.prepare('PRAGMA table_info(hozon_items)').all()
    expect(columns.map((column) => (column as { name: string }).name)).toContain('name')
  } finally {
    await first.close()
  }
})
