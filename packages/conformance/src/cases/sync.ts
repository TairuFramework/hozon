import {
  type CompareDefinition,
  compareText,
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
          await Promise.all([update(tx), update(savepoint), update(tx)])
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
    name: 'withKeyLocks orders keys',
    async run(ctx) {
      const { db, api } = await setup(ctx)
      await Promise.all(
        [
          [['a'], ['b'], ['a']],
          [['b'], ['a']],
        ].map((keys) =>
          withKeyLocks(db, 'sync_rows', keys, async (tx) => {
            const scoped = await apiFor(tx)
            for (const [id] of keys) {
              assert.ok(id)
              const current = await scoped.query
                .selectFrom('sync_rows')
                .selectAll()
                .where('id', '=', id)
                .executeTakeFirst()
              await scoped.write({ ...row((current?.major ?? 0) + 1, 0), id })
            }
          }),
        ),
      )
      assert.deepEqual(
        (await api.query.selectFrom('sync_rows').selectAll().orderBy('id').execute()).map(
          (entry) => entry.major,
        ),
        [3, 2],
      )
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
