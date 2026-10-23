import {
  type CompareDefinition,
  compareText,
  KeyLockScopeError,
  type Kysely,
  type StoreProvider,
  sql,
  withKeyLock,
  withKeyLocks,
} from '@hozon/db'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

type Row = { id: string; major: number | null; minor: number | null; text: string; value: string }
type Tables = { sync_rows: Row }
type Api = {
  query: Kysely<Tables>
  write(row: Row): Promise<{ changed: boolean }>
  undeclared(): Promise<{ changed: boolean }>
}

async function setup(ctx: CaseContext, options: Partial<CompareDefinition<Row>> = {}) {
  const db = ctx.db({ tablePrefix: 'sync_test' })
  db.register<Tables, Api>({
    name: 'sync',
    sync: { sync_rows: { key: ['id'], compare: ['major', 'minor'], ...options } },
    migrations: (migration) => ({
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('sync_rows')
            .addColumn('id', 'text', (column) => column.primaryKey())
            .addColumn('major', 'integer')
            .addColumn('minor', 'integer')
            .addColumn('text', 'text', compareText(migration))
            .addColumn('value', 'text')
            .execute()
        },
      },
    }),
    createAPI: (query, _adapter, context) => ({
      query,
      write: (row) => context.compareWrite('sync_rows', row),
      undeclared: () => context.compareWrite('undeclared', { id: 'a' }),
    }),
  })
  await db.migrate()
  return { db, api: await db.getStore<Api>('sync') }
}

const row = (major: number | null, minor: number | null, value = 'value'): Row => ({
  id: 'a',
  major,
  minor,
  value,
  text: 'B',
})
const apiFor = (provider: StoreProvider) => provider.getStore('sync') as Promise<Api>

const cases: Array<ConformanceCase> = [
  {
    name: 'compare takes the newer by ordered columns',
    async run(ctx) {
      const { api } = await setup(ctx)
      assert.deepEqual(await api.write(row(1, 5)), { changed: true })
      assert.deepEqual(await api.write(row(2, 0)), { changed: true })
      assert.deepEqual(await api.write(row(1, 9)), { changed: false })
      assert.deepEqual(await api.query.selectFrom('sync_rows').selectAll().execute(), [row(2, 0)])
    },
  },
  {
    name: 'inclusive accepts equal',
    async run(ctx) {
      const { api } = await setup(ctx, { inclusive: true })
      await api.write(row(1, 5))
      assert.deepEqual(await api.write(row(1, 5, 'replacement')), { changed: true })
      assert.equal(
        (await api.query.selectFrom('sync_rows').selectAll().executeTakeFirstOrThrow()).value,
        'replacement',
      )
    },
  },
  {
    name: 'nullsOldest lets any value beat a stored NULL',
    async run(ctx) {
      const { api } = await setup(ctx, { nullsOldest: true, inclusive: true })
      await api.write(row(null, 9))
      assert.deepEqual(await api.write(row(0, 0)), { changed: true })
      assert.deepEqual(await api.write(row(null, 10)), { changed: false })
      await api.write(row(1, null))
      assert.deepEqual(await api.write(row(1, 0)), { changed: true })
      assert.deepEqual(await api.write(row(1, null)), { changed: false })
      assert.deepEqual(await api.write(row(1, 0)), { changed: true })
    },
  },
  {
    name: 'skipUnchanged reports changed false on an equal row',
    async run(ctx) {
      const { api } = await setup(ctx, { inclusive: true, skipUnchanged: true })
      await api.write(row(1, 5))
      assert.deepEqual(await api.write(row(1, 5)), { changed: false })
      assert.deepEqual(await api.write(row(1, 5, 'replacement')), { changed: true })
    },
  },
  {
    name: 'compare on text uses byte order on postgres',
    async run(ctx) {
      if (ctx.adapter.kind !== 'postgres') return
      const { api } = await setup(ctx, { compare: ['text'] })
      const collation = await sql<{ name: string }>`
        SELECT attcollation::regcollation::text AS name FROM pg_attribute
        WHERE attrelid = 'sync_test_sync_rows'::regclass AND attname = 'text'
      `.execute(api.query)
      assert.equal(collation.rows[0]?.name, '"C"')
      await api.write(row(1, 5))
      assert.deepEqual(await api.write({ ...row(1, 5), text: 'a' }), { changed: true })
      assert.deepEqual(await api.write(row(1, 5)), { changed: false })
    },
  },
  {
    name: 'compareWrite requires a declaration',
    async run(ctx) {
      const { api } = await setup(ctx)
      await assert.rejects(() => api.undeclared(), 'declaration')
    },
  },
  {
    name: 'withKeyLock serializes calls within one transaction',
    async run(ctx) {
      const { db, api } = await setup(ctx)
      await db.withTransaction(async (tx) => {
        assert.ok(tx.withSavepoint)
        await tx.withSavepoint(async (savepoint) => {
          let active = 0
          let maximum = 0
          const update = (provider: StoreProvider) =>
            withKeyLock(provider, 'sync_rows', ['a'], async (locked) => {
              active++
              maximum = Math.max(maximum, active)
              const scoped = await apiFor(locked)
              const current = await scoped.query
                .selectFrom('sync_rows')
                .selectAll()
                .where('id', '=', 'a')
                .executeTakeFirst()
              await new Promise<void>((resolve) => setTimeout(resolve, 10))
              await scoped.write(row((current?.major ?? 0) + 1, 0))
              active--
            })
          await Promise.all([update(savepoint), update(savepoint), update(savepoint)])
          assert.equal(maximum, 1)
        })
      })
      assert.equal(
        (await api.query.selectFrom('sync_rows').selectAll().executeTakeFirstOrThrow()).major,
        3,
      )
    },
  },
  {
    name: 'withKeyLock serializes concurrent first inserts (postgres)',
    async run(ctx) {
      if (ctx.adapter.kind !== 'postgres') return
      const { db, api } = await setup(ctx)
      let active = 0
      let maximum = 0
      await Promise.all(
        Array.from({ length: 6 }, () =>
          withKeyLock(db, 'sync_rows', ['a'], async (tx) => {
            active++
            maximum = Math.max(maximum, active)
            const scoped = await apiFor(tx)
            const current = await scoped.query
              .selectFrom('sync_rows')
              .selectAll()
              .where('id', '=', 'a')
              .executeTakeFirst()
            await new Promise<void>((resolve) => setTimeout(resolve, 10))
            await scoped.write(row((current?.major ?? 0) + 1, 0))
            active--
          }),
        ),
      )
      assert.equal(maximum, 1)
      assert.equal(
        (await api.query.selectFrom('sync_rows').selectAll().executeTakeFirstOrThrow()).major,
        6,
      )
    },
  },
  {
    name: 'withKeyLocks orders keys under forced contention',
    async run(ctx) {
      const { db, api } = await setup(ctx)
      let [a, b] = ['a', 'b']
      if (ctx.adapter.kind === 'postgres') {
        const ids = await sql<{ key: string; id: string }>`
          SELECT key, (('x' || substr(md5(identity), 1, 16))::bit(64)::bigint)::text AS id
          FROM (VALUES ('a', ${JSON.stringify(['sync_test', 'sync_rows', ['a']])}::text),
                       ('b', ${JSON.stringify(['sync_test', 'sync_rows', ['b']])}::text)) AS keys(key, identity)
        `.execute(api.query)
        const ordered = ids.rows.sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1))
        const first = ordered[0]
        const second = ordered[1]
        assert.ok(first)
        assert.ok(second)
        a = first.key
        b = second.key
      }
      assert.ok(a)
      assert.ok(b)
      await db.withTransaction(async (tx) => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const holder = withKeyLock(tx, 'sync_rows', [a], async (locked) => {
          entered.resolve()
          await release.promise
          // An unsorted contender takes b while waiting for a and deadlocks this extension.
          await withKeyLock(locked, 'sync_rows', [b], async () => {})
        })
        await entered.promise
        const reversed = withKeyLocks(tx, 'sync_rows', [[b], [a]], async () => {})
        const forward = withKeyLocks(tx, 'sync_rows', [[a], [b]], async () => {})
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 30))
        } finally {
          release.resolve()
        }
        await Promise.all([holder, reversed, forward])
      })
    },
  },
  {
    name: 'skipUnchanged compares NULL columns safely',
    async run(ctx) {
      const { api } = await setup(ctx, { inclusive: true, nullsOldest: true, skipUnchanged: true })
      await api.write(row(null, null))
      assert.deepEqual(await api.write(row(null, null)), { changed: false })
      assert.deepEqual(await api.write(row(null, 0)), { changed: true })
      assert.deepEqual(await api.write(row(null, 0)), { changed: false })
    },
  },
  {
    name: 'lock ownership permits nesting but outer-provider siblings wait',
    async run(ctx) {
      const { db } = await setup(ctx)
      await db.withTransaction(async (tx) => {
        let siblingEntered = false
        let sibling: Promise<void> | undefined
        await withKeyLock(tx, 'sync_rows', ['a'], async (locked) => {
          await withKeyLock(locked, 'sync_rows', ['a'], async () => {})
          await locked.withTransaction(async (derived) => {
            await withKeyLocks(derived, 'sync_rows', [['b'], ['a']], async () => {})
          })
          assert.ok(locked.withScope)
          await locked.withScope(async (derived) => {
            await withKeyLock(derived, 'sync_rows', ['a'], async () => {})
          })
          assert.ok(locked.withSavepoint)
          await locked.withSavepoint(async (derived) => {
            await withKeyLock(derived, 'sync_rows', ['a'], async () => {})
          })
          sibling = withKeyLock(tx, 'sync_rows', ['a'], async () => {
            siblingEntered = true
          })
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
          assert.equal(siblingEntered, false)
        })
        await sibling
        assert.equal(siblingEntered, true)
      })
    },
  },
  ...(['release', 'rollback'] as const).map(
    (outcome): ConformanceCase => ({
      name: `savepoint reserves keys until ${outcome}`,
      async run(ctx) {
        const { db } = await setup(ctx)
        await db.withTransaction(async (tx) => {
          assert.ok(tx.withSavepoint)
          const ready = Promise.withResolvers<void>()
          const finish = Promise.withResolvers<void>()
          const savepoint = tx.withSavepoint(async (sp) => {
            await withKeyLock(sp, 'sync_rows', ['a'], async () => {})
            ready.resolve()
            await finish.promise
            if (outcome === 'rollback') throw new Error('rollback')
          })
          const settled = savepoint.catch((error: unknown) => {
            if (outcome !== 'rollback') throw error
          })
          await ready.promise
          try {
            await assert.rejects(
              () => withKeyLock(tx, 'sync_rows', ['a'], async () => {}),
              KeyLockScopeError,
            )
          } finally {
            finish.resolve()
            await settled
          }
          let siblingEntered = false
          let sibling: Promise<void> | undefined
          await withKeyLock(tx, 'sync_rows', ['a'], async () => {
            sibling = withKeyLock(tx, 'sync_rows', ['a'], async () => {
              siblingEntered = true
            })
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            assert.equal(siblingEntered, false)
          })
          await sibling
          assert.equal(siblingEntered, true)
        })
      },
    }),
  ),
  {
    name: 'both key queues recover after callback failure',
    async run(ctx) {
      const { db } = await setup(ctx)
      await db.withTransaction(async (tx) => {
        await assert.rejects(
          () =>
            withKeyLocks(tx, 'sync_rows', [['b'], ['a']], async () => {
              throw new Error('callback failed')
            }),
          'callback failed',
        )
        for (const key of ['a', 'b']) await withKeyLock(tx, 'sync_rows', [key], async () => {})
      })
    },
  },
  {
    name: 'both key queues recover after SQL acquisition failure',
    async run(ctx) {
      const { db } = await setup(ctx)
      if (ctx.adapter.kind === 'sqlite') {
        await db.withTransaction(async (tx) => {
          await assert.rejects(
            () => withKeyLocks(tx, 'missing', [['b'], ['a']], async () => {}),
            'no such table',
          )
          const api = await apiFor(tx)
          await api.query.schema.createTable('missing').addColumn('id', 'text').execute()
          for (const key of ['a', 'b']) await withKeyLock(tx, 'missing', [key], async () => {})
        })
        return
      }
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const holder = withKeyLock(db, 'sync_rows', ['b'], async () => {
        ready.resolve()
        await release.promise
      })
      await ready.promise
      try {
        await db.withTransaction(async (tx) => {
          const api = await apiFor(tx)
          await sql`SET LOCAL lock_timeout = '100ms'`.execute(api.query)
          const withSavepoint = tx.withSavepoint
          assert.ok(withSavepoint)
          await assert.rejects(
            () =>
              withSavepoint(async (sp) => {
                await withKeyLocks(sp, 'sync_rows', [['a'], ['b']], async () => {
                  throw new Error('Acquisition unexpectedly succeeded')
                })
              }),
            'lock timeout',
          )
          release.resolve()
          await holder
          for (const key of ['a', 'b']) await withKeyLock(tx, 'sync_rows', [key], async () => {})
        })
      } finally {
        release.resolve()
        await holder
      }
    },
  },
]

// Portable runners need their own deadline, independent of the test framework.
export const syncCases: Array<ConformanceCase> = cases.map((entry) => ({
  name: entry.name,
  async run(ctx) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entry.run(ctx),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out: ${entry.name}`)), 10_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  },
}))
