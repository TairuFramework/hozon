import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { HozonDB, Kysely, SchemaVersionError, type StoreDefinition } from '@hozon/db'
import { afterEach, describe, expect, test } from 'vitest'

import { type Backend, backends } from '../src/backends.js'
import type { RawDB } from '../src/helpers.js'

function store(
  name: string,
  keys: Array<string>,
  dependsOn?: Array<string>,
): StoreDefinition<unknown, unknown> {
  return {
    name,
    dependsOn,
    migrations: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          async up(db) {
            await db.schema
              .createTable(`sv_${name}_${key.replaceAll('-', '_')}`)
              .addColumn('id', 'integer')
              .execute()
          },
        },
      ]),
    ),
    createAPI: () => ({}),
  }
}

type Scenario = {
  name: string
  /** Stores migrated by the newer version. */
  newer: Array<StoreDefinition<unknown, unknown>>
  /** Registers the older version's stores. */
  register(db: HozonDB): void
  /** A successful access that legitimately opens and prepares the database first. */
  prepare?(db: HozonDB): Promise<unknown>
  /** The access the older version must refuse. */
  refuse(db: HozonDB): Promise<unknown>
}

const scenarios: Array<Scenario> = [
  {
    name: 'directly opened store is newer',
    newer: [store('a', ['0-init', '1-next'])],
    register: (db) => db.register(store('a', ['0-init'])),
    refuse: (db) => db.getStore('a'),
  },
  {
    name: 'only a dependsOn store is newer',
    newer: [store('base', ['0-init', '1-next']), store('app', ['0-init'], ['base'])],
    register: (db) => {
      db.register(store('app', ['0-init'], ['base']))
      db.register(store('base', ['0-init']))
    },
    refuse: (db) => db.getStore('app'),
  },
  {
    name: 'only a later-registered store is newer',
    newer: [store('first', ['0-init']), store('late', ['0-init', '1-next'])],
    register: (db) => db.register(store('first', ['0-init'])),
    prepare: (db) => db.getStore('first'),
    refuse: (db) => {
      db.register(store('late', ['0-init']))
      return db.getStore('late')
    },
  },
]

/** Migration table rows of every store in `scenario`, read with a fresh adapter. */
async function migrationRows(backend: Backend, scenario: Scenario) {
  // `delete` journal mode keeps the inspection itself from switching the file to WAL.
  const adapter = await backend.reopen({ pragmas: { journalMode: 'delete' } })
  const raw: RawDB = new Kysely({ dialect: adapter.dialect })
  try {
    const rows: Record<string, unknown> = {}
    for (const { name } of scenario.newer) {
      rows[name] = await raw
        .selectFrom(`hozon_${name}_migration`)
        .selectAll()
        .orderBy('name')
        .execute()
      rows[`${name}_lock`] = await raw
        .selectFrom(`hozon_${name}_migration_lock`)
        .selectAll()
        .execute()
    }
    return rows
  } finally {
    await raw.destroy()
    await adapter.close?.()
  }
}

describe.each(backends())('$name', (backend) => {
  afterEach(() => backend.cleanup())

  describe.each(scenarios)('$name', (scenario) => {
    test('newer migration set is refused and the database is left unchanged', async () => {
      const newer = new HozonDB({
        adapter: await backend.createAdapter({ pragmas: { journalMode: 'delete' } }),
      })
      for (const definition of scenario.newer) newer.register(definition)
      await newer.migrate()
      await newer.close()

      // Default pragmas when nothing opens successfully: preparing would switch the file to
      // WAL, so the refusal must happen before it. A scenario with a successful first access
      // keeps `delete` explicitly, so its own preparation leaves the journal mode as it was.
      const older = new HozonDB({
        adapter: await backend.reopen(
          scenario.prepare ? { pragmas: { journalMode: 'delete' } } : undefined,
        ),
      })
      scenario.register(older)
      await scenario.prepare?.(older)

      // Snapshot after any successful preparation, immediately before the refused access.
      const rowsBefore = await migrationRows(backend, scenario)
      const bytesBefore =
        backend.name === 'node-sqlite' ? await readFile(backend.location()) : undefined
      await expect(scenario.refuse(older)).rejects.toThrow(SchemaVersionError)
      await older.close()

      if (bytesBefore !== undefined) {
        expect(await readFile(backend.location())).toEqual(bytesBefore)
        const file = new DatabaseSync(backend.location(), { readOnly: true })
        try {
          expect(file.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
        } finally {
          file.close()
        }
      }
      expect(await migrationRows(backend, scenario)).toEqual(rowsBefore)
    })
  })
})
