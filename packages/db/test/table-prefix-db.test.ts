import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { Migrator } from 'kysely/migration'
import { afterEach, expect, test, vi } from 'vitest'

import type { MigrationContext, StoreDefinition } from '../src/index.js'
import { HozonDB, TablePrefixPlugin, withKeepSet, withStoreTransaction } from '../src/index.js'

type WidgetsAPI = {
  add(id: string): Promise<void>
  list(): Promise<Array<string>>
  keep(ids: Array<string>): Promise<Array<string>>
}

const instances: Array<HozonDB> = []
const directories: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(instances.splice(0).map((db) => db.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function setup(
  params: {
    database?: string
    tablePrefix?: string
    onKeep?: () => void
    secondStore?: boolean
  } = {},
) {
  const adapter = new NodeSQLiteAdapter({ database: params.database ?? ':memory:' })
  const db = new HozonDB({ adapter, tablePrefix: params.tablePrefix })
  instances.push(db)
  let context: MigrationContext | undefined
  let migrationRuns = 0
  const keepOrder: Array<string> = []
  const store: StoreDefinition<{ widgets: { id: string } }, WidgetsAPI> = {
    name: 'widgets',
    migrations: (ctx) => {
      context = ctx
      return {
        '0-init': {
          async up(query) {
            migrationRuns++
            await query.schema
              .createTable('widgets')
              .addColumn('id', 'text', (column) => column.primaryKey())
              .execute()
            await query.schema
              .createIndex(`${ctx.tablePrefix}_widgets_id`)
              .on('widgets')
              .column('id')
              .execute()
          },
          async down(query) {
            await query.schema.dropTable('widgets').execute()
          },
        },
      }
    },
    createAPI: (query) => ({
      async add(id) {
        await query.insertInto('widgets').values({ id }).execute()
      },
      async list() {
        const rows = await query.selectFrom('widgets').select('id').orderBy('id').execute()
        return rows.map((row) => row.id)
      },
      async keep(ids) {
        return withStoreTransaction(query, (trx) => {
          return withKeepSet(trx, { table: 'keep_widgets', ids }, async (selectKeep) => {
            keepOrder.push(`start-${ids.join(',')}`)
            params.onKeep?.()
            const rows = await selectKeep().orderBy('trace_id').execute()
            keepOrder.push(`end-${ids.join(',')}`)
            return rows.map((row) => row.trace_id)
          })
        })
      },
    }),
  }
  db.register(store)
  if (params.secondStore) {
    db.register({ ...store, name: 'widget-reader', dependsOn: ['widgets'], migrations: {} })
  }
  const names = () => {
    return adapter.database
      .prepare('SELECT name FROM sqlite_master ORDER BY name')
      .all()
      .map((row) => row.name)
  }
  return {
    db,
    adapter,
    names,
    keepOrder,
    context: () => context,
    runs: () => migrationRuns,
  }
}

test('store tables and indexes use the db prefix', async () => {
  const { db, names } = setup({ tablePrefix: 'kubun' })
  const widgets = await db.getStore<WidgetsAPI>('widgets')
  await widgets.add('root')
  expect(await widgets.list()).toEqual(['root'])
  expect(names()).toEqual(
    expect.arrayContaining(['kubun_widgets', 'kubun_widgets_id', 'kubun_widgets_migration']),
  )
  expect(names()).not.toContain('widgets')
})

test('migration context exposes tablePrefix', async () => {
  const { db, context } = setup({ tablePrefix: 'kubun' })
  await db.getStore('widgets')
  expect(context()?.tablePrefix).toBe('kubun')
})

test('migrating twice is a no-op and never double-prefixes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hozon-prefix-'))
  directories.push(directory)
  const params = { database: join(directory, 'test.sqlite'), tablePrefix: 'kubun' }
  const first = setup(params)
  await (await first.db.getStore<WidgetsAPI>('widgets')).add('persisted')
  expect(first.runs()).toBe(1)
  await first.db.close()
  const second = setup(params)
  expect(await (await second.db.getStore<WidgetsAPI>('widgets')).list()).toEqual(['persisted'])
  expect(second.runs()).toBe(0)
  expect(second.names()).toContain('kubun_widgets')
  expect(second.names().some((name) => String(name).startsWith('kubun_kubun_'))).toBe(false)
})

test('store API in withTransaction uses the prefix', async () => {
  const { db, adapter } = setup({ tablePrefix: 'kubun' })
  await db.withTransaction<{ widgets: WidgetsAPI }, void>(async (tx) => {
    await (await tx.getStore('widgets')).add('transaction')
  })
  expect(await (await db.getStore<WidgetsAPI>('widgets')).list()).toEqual(['transaction'])
  expect(adapter.database.prepare('SELECT id FROM kubun_widgets').all()).toEqual([
    { id: 'transaction' },
  ])
})

test('keep-set temp table is prefixed and calls serialize', async () => {
  const transformQuery = TablePrefixPlugin.prototype.transformQuery
  vi.spyOn(TablePrefixPlugin.prototype, 'transformQuery').mockImplementation(function (
    this: TablePrefixPlugin,
    args,
  ) {
    expect(JSON.stringify(args.node)).not.toMatch(/\bsqlite_(?:temp_)?master\b/)
    return transformQuery.call(this, args)
  })
  const keepNames: Array<string> = []
  const { db, adapter, keepOrder } = setup({
    tablePrefix: 'kubun',
    onKeep: () => {
      // The adapter owns the transaction's connection, including its temporary tables.
      const names = adapter.database.prepare('SELECT name FROM sqlite_temp_master').all()
      keepNames.push(...names.map((row) => String(row.name)))
    },
  })
  await db.withTransaction<{ widgets: WidgetsAPI }, void>(async (tx) => {
    const widgets = await tx.getStore('widgets')
    expect(await Promise.all([widgets.keep(['a']), widgets.keep(['b', 'c'])])).toEqual([
      ['a'],
      ['b', 'c'],
    ])
  })
  expect(keepNames.filter((name) => name === 'kubun_keep_widgets')).toHaveLength(2)
  expect(keepNames).not.toContain('keep_widgets')
  expect(keepOrder).toEqual(['start-a', 'end-a', 'start-b,c', 'end-b,c'])
  // Root store operations must also inherit the plugin through withStoreTransaction.
  expect(await (await db.getStore<WidgetsAPI>('widgets')).keep(['root'])).toEqual(['root'])
  expect(keepNames.filter((name) => name === 'kubun_keep_widgets')).toHaveLength(3)
})

test('default prefix keeps hozon_ names', async () => {
  const { db, names, context } = setup()
  await db.getStore('widgets')
  expect(names()).toEqual(
    expect.arrayContaining(['hozon_widgets', 'hozon_widgets_id', 'hozon_widgets_migration']),
  )
  expect(context()?.tablePrefix).toBe('hozon')
})

test('two stores sharing a keep-table serialize concurrent calls in one transaction', async () => {
  const { db, adapter, keepOrder } = setup({ tablePrefix: 'app', secondStore: true })
  await db.withTransaction<{ widgets: WidgetsAPI; 'widget-reader': WidgetsAPI }, void>(
    async (tx) => {
      const first = await tx.getStore('widgets')
      const second = await tx.getStore('widget-reader')
      expect(first).not.toBe(second)
      expect(await Promise.all([first.keep(['a']), second.keep(['b', 'c'])])).toEqual([
        ['a'],
        ['b', 'c'],
      ])
    },
  )
  expect(keepOrder).toEqual(['start-a', 'end-a', 'start-b,c', 'end-b,c'])
  expect(adapter.database.prepare('SELECT name FROM sqlite_temp_master').all()).toEqual([])
})

test('migration down drops prefixed tables', async () => {
  let migrator: Migrator | undefined
  const migrateToLatest = Migrator.prototype.migrateToLatest
  vi.spyOn(Migrator.prototype, 'migrateToLatest').mockImplementation(function (this: Migrator) {
    migrator = this
    return migrateToLatest.call(this)
  })
  const { db, names } = setup({ tablePrefix: 'kubun' })
  await db.getStore('widgets')
  expect(names()).toContain('kubun_widgets')
  if (migrator == null) throw new Error('Migrator was not captured')
  const result = await migrator.migrateDown()
  expect(result.error).toBeUndefined()
  expect(result.results).toEqual([
    { migrationName: '0-init', direction: 'Down', status: 'Success' },
  ])
  expect(names()).not.toContain('kubun_widgets')
  expect(names()).not.toContain('kubun_widgets_id')
})
