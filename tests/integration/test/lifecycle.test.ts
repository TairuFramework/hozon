import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { HozonDB, SchemaVersionError, type StoreDefinition } from '@hozon/db'
import { getLogStore, logStoreDefinition } from '@hozon/store-log'
import { getTelemetryStore, telemetryStoreDefinition } from '@hozon/store-telemetry'
import { afterEach, describe, expect, test } from 'vitest'

import { backends, backendsNamed } from '../src/backends.js'
import { type RawDB, rawStore, sampleSpan, tableNames, tracedLog } from '../src/helpers.js'

function itemsStore(table: string): StoreDefinition<unknown, RawDB> {
  return {
    name: 'items',
    migrations: {
      '0-init': {
        async up(db) {
          await db.schema
            .createTable(table)
            .addColumn('id', 'integer', (column) => column.primaryKey())
            .execute()
        },
      },
    },
    createAPI: (db) => db as RawDB,
  }
}

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const open = async (params: { reopen?: boolean; tablePrefix?: string } = {}) => {
    const adapter = params.reopen ? await backend.reopen() : await backend.createAdapter()
    const db = new HozonDB({ adapter, tablePrefix: params.tablePrefix })
    databases.push(db)
    return db
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('reopen keeps data', async () => {
    const first = await open()
    first.register(logStoreDefinition)
    first.register(telemetryStoreDefinition)
    const logs = [tracedLog(1, 'kept', 'trace-a')]
    const spans = [sampleSpan('trace-a', 'span-a', 1)]
    await (await getLogStore(first)).addLogs(logs)
    await (await getTelemetryStore(first)).addSpans(spans)
    await first.close()

    const second = await open({ reopen: true })
    second.register(logStoreDefinition)
    second.register(telemetryStoreDefinition)
    expect(await (await getLogStore(second)).getTraceLogs('trace-a')).toEqual(logs)
    expect(await (await getTelemetryStore(second)).getSpans('trace-a')).toEqual(spans)
  })

  test('dependsOn migrates the dependency first and survives reopen', async () => {
    const order: Array<string> = []
    const base: StoreDefinition<unknown, RawDB> = {
      name: 'base',
      migrations: {
        '0-init': {
          async up(db) {
            order.push('base')
            await db.schema
              .createTable('lc_base')
              .addColumn('id', 'integer', (column) => column.primaryKey())
              .execute()
          },
        },
      },
      createAPI: (db) => db as RawDB,
    }
    const dependent: StoreDefinition<unknown, RawDB> = {
      name: 'dependent',
      dependsOn: ['base'],
      migrations: {
        '0-init': {
          async up(db) {
            order.push('dependent')
            await db.schema
              .createTable('lc_dependent')
              .addColumn('id', 'integer', (column) => column.primaryKey())
              .addColumn('base_id', 'integer', (column) =>
                column.notNull().references('lc_base.id'),
              )
              .execute()
          },
        },
      },
      createAPI: (db) => db as RawDB,
    }
    const first = await open()
    first.register(dependent)
    first.register(base)
    const query = await first.getStore<RawDB>('dependent')
    expect(order).toEqual(['base', 'dependent'])
    await query.insertInto('lc_base').values({ id: 1 }).execute()
    await query.insertInto('lc_dependent').values({ id: 1, base_id: 1 }).execute()
    await first.close()

    const second = await open({ reopen: true })
    second.register(dependent)
    second.register(base)
    const reopened = await second.getStore<RawDB>('dependent')
    expect(order).toEqual(['base', 'dependent'])
    expect(await reopened.selectFrom('lc_dependent').selectAll().execute()).toEqual([
      { id: 1, base_id: 1 },
    ])
  })

  test('two table prefixes on one database keep disjoint stores', async () => {
    const alpha = await open({ tablePrefix: 'alpha' })
    const beta = await open({ reopen: true, tablePrefix: 'beta' })
    alpha.register(itemsStore('alpha_items'))
    beta.register(itemsStore('beta_items'))
    const alphaItems = await alpha.getStore<RawDB>('items')
    const betaItems = await beta.getStore<RawDB>('items')
    await alphaItems.insertInto('alpha_items').values({ id: 1 }).execute()
    await betaItems.insertInto('beta_items').values({ id: 2 }).execute()

    const tables = await tableNames(alphaItems)
    expect(tables).toEqual(
      expect.arrayContaining([
        'alpha_items',
        'alpha_items_migration',
        'alpha_items_migration_lock',
        'beta_items',
        'beta_items_migration',
        'beta_items_migration_lock',
      ]),
    )
    expect(tables).not.toContain('hozon_items_migration')
    for (const prefix of ['alpha', 'beta']) {
      const rows = await alphaItems.selectFrom(`${prefix}_items_migration`).select('name').execute()
      expect(rows).toEqual([{ name: '0-init' }])
    }
    expect(await alphaItems.selectFrom('alpha_items').selectAll().execute()).toEqual([{ id: 1 }])
    expect(await betaItems.selectFrom('beta_items').selectAll().execute()).toEqual([{ id: 2 }])
  })

  test('failed migration rolls back and retries on next open', async () => {
    let attempts = 0
    const flaky: StoreDefinition<unknown, RawDB> = {
      name: 'flaky',
      migrations: {
        '0-init': {
          async up(db) {
            attempts++
            // `ifNotExists`: SQLite DDL is not transactional in Kysely's migrator, so a
            // failed attempt may leave the table behind there (Postgres rolls it back).
            await db.schema
              .createTable('lc_flaky')
              .ifNotExists()
              .addColumn('id', 'integer')
              .execute()
            if (attempts === 1) throw new Error('migration failed on first open')
          },
        },
      },
      createAPI: (db) => db as RawDB,
    }
    const first = await open()
    first.register(flaky)
    first.register(rawStore)
    await expect(first.getStore('flaky')).rejects.toThrow('migration failed on first open')
    const raw = await first.getStore<RawDB>('raw')
    expect(await raw.selectFrom('hozon_flaky_migration').select('name').execute()).toEqual([])
    if (backend.name === 'postgres') {
      expect(await tableNames(raw)).not.toContain('lc_flaky')
    }
    await first.close()

    const second = await open({ reopen: true })
    second.register(flaky)
    const query = await second.getStore<RawDB>('flaky')
    expect(attempts).toBe(2)
    expect(await query.selectFrom('hozon_flaky_migration').select('name').execute()).toEqual([
      { name: '0-init' },
    ])
    expect(await tableNames(query)).toContain('lc_flaky')
  })
})

describe.each(backendsNamed('node-sqlite'))('$name file handles', (backend) => {
  afterEach(() => backend.cleanup())

  const futureStore = (keys: Array<string>): StoreDefinition<unknown, unknown> => ({
    name: 's',
    migrations: Object.fromEntries(keys.map((key) => [key, { async up() {} }])),
    createAPI: () => ({}),
  })

  test('failed open on a newer schema releases the file', async () => {
    const writer = new HozonDB({ adapter: await backend.createAdapter() })
    writer.register(futureStore(['0-init', '1-future']))
    await writer.migrate()
    await writer.close()

    const reader = new HozonDB({ adapter: await backend.reopen() })
    reader.register(futureStore(['0-init']))
    await expect(reader.migrate()).rejects.toThrow(SchemaVersionError)
    await reader.close()
    await rm(backend.location())
    expect(existsSync(backend.location())).toBe(false)
  })

  test('failed migration releases the file', async () => {
    const db = new HozonDB({ adapter: await backend.createAdapter() })
    db.register({
      name: 'broken',
      migrations: {
        '0-init': {
          async up() {
            throw new Error('broken migration')
          },
        },
      },
      createAPI: () => ({}),
    })
    await expect(db.migrate()).rejects.toThrow('broken migration')
    await db.close()
    await rm(backend.location())
    expect(existsSync(backend.location())).toBe(false)
  })
})
