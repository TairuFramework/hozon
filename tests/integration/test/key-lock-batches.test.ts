import type { Adapter } from '@hozon/adapter'
import { describe, expect, test } from 'vitest'

// Exercise source before rebuilding the shared workspace libraries.
import { HozonDB, type Kysely, sql, withKeyLocks } from '../../../packages/db/src/index.js'
import { backendsNamed } from '../src/backends.js'

function observe(adapter: Adapter) {
  const queries: Array<{ sql: string; parameters: ReadonlyArray<unknown> }> = []
  const driver = adapter.dialect.createDriver.bind(adapter.dialect)
  adapter.dialect.createDriver = () => {
    const instance = driver()
    const acquire = instance.acquireConnection.bind(instance)
    const wrapped = new WeakSet<object>()
    instance.acquireConnection = async () => {
      const connection = await acquire()
      if (!wrapped.has(connection)) {
        wrapped.add(connection)
        const execute = connection.executeQuery.bind(connection)
        connection.executeQuery = async (query, options) => {
          if (query.sql.includes('md5(') || query.sql.includes('pg_advisory_xact_lock')) {
            queries.push(query)
          }
          return await execute(query, options)
        }
      }
      return connection
    }
    return instance
  }
  return queries
}

function setup(adapter: Adapter) {
  const db = new HozonDB({ adapter, tablePrefix: 'batch_locks' })
  db.register({ name: 'probe', migrations: {}, createAPI: (query) => query })
  return db
}

async function query(db: HozonDB) {
  return await db.getStore<Kysely<Record<string, unknown>>>('probe')
}

describe.each(backendsNamed('postgres'))('$name batched key locks', (backend) => {
  test.each([0, 1, 256, 1001])(
    'admits %i distinct keys in at most two round trips',
    async (size) => {
      const adapter = await backend.createAdapter()
      const queries = observe(adapter)
      const db = setup(adapter)
      try {
        const keys = Array.from({ length: size }, (_, index) => ['key', index])
        const start = performance.now()
        await withKeyLocks(db, 'items', [...keys.toReversed(), ...keys], async () => {})
        const elapsed = performance.now() - start
        console.log(JSON.stringify({ keys: size, admissionMS: elapsed, queries: queries.length }))
        expect(queries.length).toBeLessThanOrEqual(size === 0 ? 0 : 2)
        for (const statement of queries)
          expect(statement.parameters.length).toBeLessThanOrEqual(500)
      } finally {
        await db.close()
        await backend.cleanup()
      }
    },
  )

  test.each(['commit', 'rollback'])(
    'legacy hashes stay locked until transaction %s',
    async (outcome) => {
      const db = setup(await backend.createAdapter())
      const other = setup(await backend.reopen())
      try {
        const competitor = await query(other)
        const keys = [['a'], ['quoted"', 42], ['unicode-雪', -1], ['a']]
        const hashes = await Promise.all(
          keys.slice(0, 3).map(async (key) => {
            const result = await sql<{ id: string }>`SELECT
          (('x' || substr(md5(${JSON.stringify(['batch_locks', 'items', key])}::text), 1, 16))::bit(64)::bigint)::text AS id
        `.execute(competitor)
            const row = result.rows[0]
            if (!row) throw new Error('Missing legacy hash')
            return row.id
          }),
        )
        const attempt = async (expected: boolean) => {
          for (const id of hashes) {
            // Each try-lock lives in its own transaction, so a successful probe releases it.
            await other.withTransaction(async (tx) => {
              const result = await sql<{
                acquired: boolean
              }>`SELECT pg_try_advisory_xact_lock(${id}::bigint) AS acquired`.execute(
                (await tx.getStore('probe')) as Kysely<Record<string, unknown>>,
              )
              expect(result.rows).toEqual([{ acquired: expected }])
            })
          }
        }
        const transaction = db.withTransaction(async (tx) => {
          await withKeyLocks(tx, 'items', keys, async (locked) => {
            expect(await withKeyLocks(locked, 'items', keys, async () => 'nested')).toBe('nested')
            await attempt(false)
          })
          await attempt(false)
          if (outcome === 'rollback') throw new Error('rollback batch')
        })
        if (outcome === 'rollback') await expect(transaction).rejects.toThrow('rollback batch')
        else await transaction
        await attempt(true)
      } finally {
        await Promise.all([db.close(), other.close()])
        await backend.cleanup()
      }
    },
  )

  test('overlapping reversed batches wait on the lowest signed hash before taking higher locks', async () => {
    const db = setup(await backend.createAdapter())
    const other = setup(await backend.reopen())
    const release = Promise.withResolvers<void>()
    let holder: Promise<void> | undefined
    let contender: Promise<void> | undefined
    try {
      const inspector = await query(other)
      const rows = await sql<{ key: string; id: string }>`SELECT key,
        (('x' || substr(md5(identity), 1, 16))::bit(64)::bigint)::text AS id
        FROM (VALUES ('a', ${JSON.stringify(['batch_locks', 'items', ['a']])}::text),
                     ('b', ${JSON.stringify(['batch_locks', 'items', ['b']])}::text)) AS keys(key, identity)
      `.execute(inspector)
      const [low, high] = rows.rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      if (!low || !high) throw new Error('Missing hashes')
      const ready = Promise.withResolvers<void>()
      holder = other.withTransaction(async (tx) => {
        const connection = (await tx.getStore('probe')) as Kysely<Record<string, unknown>>
        await sql`SELECT pg_advisory_xact_lock(${low.id}::bigint)`.execute(connection)
        ready.resolve()
        await release.promise
        // If the contender acquired high before blocking on low, this deadlocks.
        await withKeyLocks(tx, 'items', [[high.key], [low.key]], async () => {})
      })
      await ready.promise
      contender = withKeyLocks(db, 'items', [[high.key], [low.key], [high.key]], async () => {})
      await expect
        .poll(async () => {
          const result = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(
            inspector,
          )
          return result.rows[0]?.count
        })
        .toBe('1')
      const probe = await sql<{
        acquired: boolean
      }>`SELECT pg_try_advisory_xact_lock(${high.id}::bigint) AS acquired`.execute(inspector)
      expect(probe.rows).toEqual([{ acquired: true }])
      release.resolve()
      await Promise.all([holder, contender])
    } finally {
      release.resolve()
      await Promise.allSettled([holder, contender])
      await Promise.all([db.close(), other.close()])
      await backend.cleanup()
    }
  })
})
