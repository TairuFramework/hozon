import { DatabaseSync } from 'node:sqlite'
import { runConformance, syncCases } from '@hozon/conformance'
import { HozonDB, withKeyLock } from '@hozon/db'
import { describe, expect, test } from 'vitest'

import { backends, backendsNamed } from '../src/backends.js'

describe.each(backends())('$name sync', (backend) => {
  for (const entry of syncCases) {
    test(entry.name, async () => {
      const results = await runConformance({
        createAdapter: () => backend.createAdapter(),
        cleanup: () => backend.cleanup(),
        cases: [entry],
      })
      expect(results).toEqual([{ name: entry.name, ok: true }])
    }, 20_000)
  }
})

describe.each(backendsNamed('node-sqlite'))('$name writer reservation', (backend) => {
  test('withKeyLock reserves the writer before reading an absent key', async () => {
    const db = new HozonDB({ adapter: await backend.createAdapter(), tablePrefix: 'reservation' })
    db.register({
      name: 'probe',
      migrations: {
        '0-init': {
          async up(query) {
            await query.schema
              .createTable('probe')
              .addColumn('id', 'text', (column) => column.primaryKey())
              .execute()
          },
        },
      },
      createAPI: (query) => query,
    })
    let competing: DatabaseSync | undefined
    try {
      await db.migrate()
      competing = new DatabaseSync(backend.location())
      competing.exec('PRAGMA busy_timeout = 0')
      const insert = competing.prepare('INSERT INTO reservation_probe (id) VALUES (?)')
      await withKeyLock(db, 'probe', ['absent'], async (tx) => {
        expect(tx.isTransactionBound).toBe(true)
        expect(competing?.prepare('SELECT * FROM reservation_probe').all()).toEqual([])
        expect(() => insert.run('competitor')).toThrow('database is locked')
      })
      expect(() => insert.run('after_commit')).not.toThrow()
    } finally {
      competing?.close()
      await db.close()
      await backend.cleanup()
    }
  }, 10_000)
})
