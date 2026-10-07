import { SchemaVersionError } from '@hozon/db'
import { Kysely } from 'kysely'

import * as assert from '../assert.js'
import type { ConformanceCase } from '../runner.js'

export const migrationCases: Array<ConformanceCase> = [
  {
    name: 'migrations: lazy first access runs once',
    async run(ctx) {
      const db = ctx.db()
      let runs = 0
      db.register({
        name: 's',
        migrations: {
          '0-init': {
            async up() {
              runs++
            },
          },
        },
        createAPI: () => ({ ready: true }),
      })
      assert.equal(runs, 0)
      assert.equal(db.hasStore('s'), true)
      assert.equal(runs, 0)
      const first = await db.getStore<{ ready: boolean }>('s')
      assert.equal(first.ready, true)
      assert.equal(runs, 1)
      assert.equal(await db.getStore('s'), first)
      assert.equal(runs, 1)
    },
  },
  {
    name: 'migrations: dependencies migrate first',
    async run(ctx) {
      const db = ctx.db()
      const order: Array<string> = []
      for (const name of ['dependent', 'base']) {
        db.register({
          name,
          dependsOn: name === 'dependent' ? ['base'] : [],
          migrations: {
            '0-init': {
              async up() {
                order.push(name)
              },
            },
          },
          createAPI: () => ({}),
        })
      }
      await db.getStore('dependent')
      assert.deepEqual(order, ['base', 'dependent'])
    },
  },
  {
    name: 'migrations: failed migration retries',
    async run(ctx) {
      const db = ctx.db()
      let attempts = 0
      db.register({
        name: 's',
        migrations: {
          '0-init': {
            async up(query) {
              if (++attempts === 1) throw new Error('transient migration failure')
              await query.schema
                .createTable('conformance_retry')
                .addColumn('id', 'integer')
                .execute()
            },
          },
        },
        createAPI: () => ({ ready: true }),
      })
      await assert.rejects(() => db.getStore('s'), 'transient migration failure')
      assert.equal((await db.getStore<{ ready: boolean }>('s')).ready, true)
      assert.equal(attempts, 2)
    },
  },
  {
    name: 'migrations: unknown recorded version rejects',
    async run(ctx) {
      const db = ctx.db()
      type Tables = { hozon_s_migration: { name: string; timestamp: string } }
      const seed = new Kysely<Tables>({ dialect: ctx.adapter.dialect })
      await seed.schema
        .createTable('hozon_s_migration')
        .addColumn('name', 'varchar(255)', (column) => column.primaryKey())
        .addColumn('timestamp', 'varchar(255)', (column) => column.notNull())
        .execute()
      await seed
        .insertInto('hozon_s_migration')
        .values({ name: 'future-version', timestamp: '2026-01-01T00:00:00.000Z' })
        .execute()
      db.register({ name: 's', migrations: {}, createAPI: () => ({}) })
      await assert.rejects(() => db.getStore('s'), SchemaVersionError)
    },
  },
  {
    name: 'migrations: custom prefix names migration tables',
    async run(ctx) {
      const db = ctx.db({ tablePrefix: 'custom' })
      db.register({
        name: 's',
        migrations: { '0-init': { async up() {} } },
        createAPI: () => ({}),
      })
      await db.getStore('s')
      const query = new Kysely<{ custom_s_migration: { name: string } }>({
        dialect: ctx.adapter.dialect,
      })
      const rows = await query.selectFrom('custom_s_migration').select('name').execute()
      assert.deepEqual(rows, [{ name: '0-init' }])
      const tables = await query.introspection.getTables()
      assert.ok(tables.some((table) => table.name === 'custom_s_migration_lock'))
      assert.ok(!tables.some((table) => table.name === 'hozon_s_migration'))
    },
  },
]
