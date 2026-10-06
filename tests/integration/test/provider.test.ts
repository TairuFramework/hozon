import type { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { PostgresAdapter } from '@hozon/postgres'
import { resolveDB } from '@hozon/provider'
import { getLogStore, logStoreDefinition } from '@hozon/store-log'
import { sql } from 'kysely'
import { afterEach, describe, expect, test } from 'vitest'

import { backends, backendsNamed } from '../src/backends.js'
import { type RawDB, rawStore, sampleLog } from '../src/helpers.js'

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('resolveDB opens a working database from its path or URL', async () => {
    // Create the database through the backend, then resolve it from its location string.
    await (await backend.createAdapter()).close?.()
    const db = resolveDB(backend.location(), { tablePrefix: 'resolved' })
    databases.push(db)
    expect(db.adapter).toBeInstanceOf(
      backend.name === 'postgres' ? PostgresAdapter : NodeSQLiteAdapter,
    )
    db.register(logStoreDefinition)
    const store = await getLogStore(db)
    const logs = [sampleLog(1, 'resolved')]
    await store.addLogs(logs)
    expect((await store.queryLogs({ limit: 10 })).logs).toEqual(logs)
    await db.close()

    const reopened = resolveDB(backend.location(), { tablePrefix: 'resolved' })
    databases.push(reopened)
    reopened.register(logStoreDefinition)
    expect((await (await getLogStore(reopened)).queryLogs({ limit: 10 })).logs).toEqual(logs)
  })
})

describe.each(backendsNamed('postgres'))('$name int8 parsing', (backend) => {
  const databases: Array<HozonDB> = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  const selectInt8 = async (db: HozonDB): Promise<unknown> => {
    databases.push(db)
    db.register(rawStore)
    const raw = await db.getStore<RawDB>('raw')
    const { rows } = await sql<{ value: unknown }>`SELECT 9007199254740993::int8 AS value`.execute(
      raw,
    )
    return rows[0]?.value
  }

  test('int8 columns parse to numbers by default', async () => {
    const db = resolveDB(await backend.createAdapter())
    expect(await selectInt8(db)).toBe(Number('9007199254740993'))
  })

  test('caller-provided int8 parsers take precedence', async () => {
    const adapter = await backend.createAdapter({
      postgres: {
        types: {
          int8: {
            to: 20,
            from: [20],
            serialize: (value: bigint) => value.toString(),
            parse: (value: string) => BigInt(value),
          },
        },
      },
    })
    expect(await selectInt8(resolveDB(adapter))).toBe(9007199254740993n)
  })
})
