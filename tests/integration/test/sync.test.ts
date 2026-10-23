import { DatabaseSync } from 'node:sqlite'
import { runConformance, syncCases } from '@hozon/conformance'
import { HozonDB, type Kysely, sql, withKeyLock, withKeyLocks } from '@hozon/db'
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

describe.each(backendsNamed('postgres'))('$name lock failure cleanup', (backend) => {
  test('both keys can be reacquired after an SQL lock timeout', async () => {
    const db = new HozonDB({ adapter: await backend.createAdapter(), tablePrefix: 'lock_failure' })
    const other = new HozonDB({ adapter: await backend.reopen(), tablePrefix: 'lock_failure' })
    db.register({ name: 'probe', migrations: {}, createAPI: (query) => ({ query }) })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = withKeyLock(other, 'items', ['b'], async () => {
      entered.resolve()
      await release.promise
    })
    try {
      await entered.promise
      await db.withTransaction(async (tx) => {
        if (!tx.withSavepoint) throw new Error('Missing savepoints')
        await expect(
          tx.withSavepoint(async (sp) => {
            // SET uses the same transaction connection as the lock helpers.
            const query = (await sp.getStore('probe')) as { query: Kysely<Record<string, unknown>> }
            await sql`SET LOCAL lock_timeout = '100ms'`.execute(query.query)
            await withKeyLocks(sp, 'items', [['a'], ['b']], async () => {})
          }),
        ).rejects.toThrow('lock timeout')
        release.resolve()
        await blocker
        for (const key of ['a', 'b']) {
          await withKeyLock(tx, 'items', [key], async () => {})
        }
      })
    } finally {
      release.resolve()
      await blocker
      await Promise.all([db.close(), other.close()])
      await backend.cleanup()
    }
  }, 10_000)
})
