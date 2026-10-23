import type { SearchCapability } from '@hozon/adapter'
import { type Kysely, sql } from '@hozon/db'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

type Tables = { documents: { id: string } }
const longIndex = `fts_${'x'.repeat(59)}`

async function setup(ctx: CaseContext, exempt = true) {
  const search = ctx.adapter.search
  assert.ok(search)
  const db = ctx.db({ tablePrefix: 'search_test' })
  db.register<Tables, Kysely<Tables>>({
    name: 'search',
    unprefixedTables: exempt ? (name) => name.startsWith('fts_') : undefined,
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('documents')
            .addColumn('id', 'text', (column) => column.primaryKey())
            .execute()
        },
      },
    },
    createAPI: (query) => query,
  })
  const query = await db.getStore<Kysely<Tables>>('search')
  await query
    .insertInto('documents')
    .values(['a', 'b', 'c'].map((id) => ({ id })))
    .execute()
  return { db, query, search }
}

const definition = {
  index: 'fts_documents',
  table: 'documents',
  key: 'id',
  fields: ['title', 'body'],
}
const keys = async (search: SearchCapability, db: Kysely<Tables>, query: string, limit = 10) =>
  (await search.query(db, { index: definition.index, query, limit })).map((hit) => hit.key)

const cases: Array<ConformanceCase> = [
  {
    name: 'search creates, ranks, replaces, removes and drops entries',
    async run(ctx) {
      const { query, search } = await setup(ctx)
      await search.createIndex(query, definition)
      await search.createIndex(query, definition)
      assert.deepEqual(await keys(search, query, 'hello'), [])
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'a',
        fields: { title: 'hello hello hello', body: 'world' },
      })
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'b',
        fields: { title: 'hello', body: 'world' },
      })
      const hits = await search.query(query, { index: definition.index, query: 'hello', limit: 10 })
      assert.deepEqual(
        hits.map((hit) => hit.key),
        ['a', 'b'],
      )
      assert.ok(hits.every((hit) => Number.isFinite(hit.rank)))
      const [first, second] = hits
      assert.ok(first && second)
      assert.ok(ctx.adapter.kind === 'sqlite' ? first.rank < second.rank : first.rank > second.rank)
      assert.deepEqual(await keys(search, query, 'hello', 1), ['a'])
      assert.deepEqual(await keys(search, query, 'absent'), [])
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'a',
        fields: { title: 'replacement', body: '' },
      })
      assert.deepEqual(await keys(search, query, 'hello'), ['b'])
      assert.deepEqual(await keys(search, query, 'replacement'), ['a'])
      await search.removeEntry(query, { index: definition.index, key: 'a' })
      await search.removeEntry(query, { index: definition.index, key: 'a' })
      assert.deepEqual(await keys(search, query, 'replacement'), [])
      await query.insertInto('documents').values({ id: "quoted'雪" }).execute()
      await search.upsertEntry(query, {
        index: definition.index,
        key: "quoted'雪",
        fields: { title: '', body: 'bodyneedle' },
      })
      assert.deepEqual(await keys(search, query, 'bodyneedle'), ["quoted'雪"])
      await search.dropIndex(query, definition)
      await search.createIndex(query, definition)
      assert.deepEqual(await keys(search, query, 'hello'), [])
      await search.dropIndex(query, definition)
      await search.dropIndex(query, definition)
      await assert.rejects(() => keys(search, query, 'hello'), Error)
    },
  },
  ...[false, true].map(
    (exempt): ConformanceCase => ({
      name: `search honours table prefixes with exemption=${exempt}`,
      async run(ctx) {
        const { query, search } = await setup(ctx, exempt)
        const index = exempt ? longIndex : 'fts_documents'
        await search.createIndex(query, { ...definition, index })
        await search.createIndex(query, { ...definition, index })
        await search.upsertEntry(query, { index, key: 'a', fields: { title: 'needle', body: '' } })
        assert.deepEqual(
          (await search.query(query, { index, query: 'needle', limit: 1 })).map((hit) => hit.key),
          ['a'],
        )
        const physical = exempt ? index : `search_test_${index}`
        const tables = await query.withoutPlugins().introspection.getTables()
        assert.ok(tables.some((table) => table.name === physical))
        assert.ok(tables.some((table) => table.name === 'search_test_documents'))
        if (ctx.adapter.kind === 'postgres') {
          const indexes = await sql<{
            indexname: string
          }>`SELECT indexname FROM pg_indexes WHERE tablename = ${physical} AND indexdef LIKE '%USING gin%'`.execute(
            query,
          )
          assert.equal(indexes.rows.length, 1)
          const gin = indexes.rows[0]
          assert.ok(gin)
          assert.ok(/^search_[0-9a-f]{1,16}$/.test(gin.indexname))
        }
        await search.dropIndex(query, { index })
        assert.ok(
          !(await query.withoutPlugins().introspection.getTables()).some(
            (table) => table.name === physical,
          ),
        )
      },
    }),
  ),
  {
    name: 'search rejects orphan keys and cascades owning deletions on postgres',
    async run(ctx) {
      if (ctx.adapter.kind !== 'postgres') return
      const { query, search } = await setup(ctx)
      await search.createIndex(query, definition)
      await assert.rejects(
        () =>
          search.upsertEntry(query, {
            index: definition.index,
            key: 'missing',
            fields: { title: 'needle', body: '' },
          }),
        'foreign key',
      )
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'a',
        fields: { title: 'needle', body: '' },
      })
      await query.deleteFrom('documents').where('id', '=', 'a').execute()
      assert.deepEqual(await keys(search, query, 'needle'), [])
    },
  },
  {
    name: 'search query executes one statement and breaks equal ranks by text key',
    async run(ctx) {
      const { query, search } = await setup(ctx)
      await search.createIndex(query, definition)
      for (const key of ['b', 'a']) {
        await search.upsertEntry(query, {
          index: definition.index,
          key,
          fields: { title: 'needle', body: '' },
        })
      }
      let statements = 0
      const observed = query.withPlugin({
        transformQuery({ node }) {
          statements++
          return node
        },
        async transformResult({ result }) {
          return result
        },
      })
      assert.deepEqual(await keys(search, observed, 'needle'), ['a', 'b'])
      assert.equal(statements, 1)
      statements = 0
      assert.deepEqual(await keys(search, observed, 'absent'), [])
      assert.equal(statements, 1)
    },
  },
  {
    name: 'search uses the supplied transaction and rolls replacement back',
    async run(ctx) {
      const { db, query, search } = await setup(ctx)
      await search.createIndex(query, definition)
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'a',
        fields: { title: 'original', body: '' },
      })
      await assert.rejects(
        () =>
          db.withTransaction<{ search: Kysely<Tables> }, void>(async (tx) => {
            const scoped = await tx.getStore('search')
            await search.upsertEntry(scoped, {
              index: definition.index,
              key: 'a',
              fields: { title: 'replacement', body: '' },
            })
            assert.deepEqual(await keys(search, scoped, 'replacement'), ['a'])
            throw new Error('rollback search')
          }),
        'rollback search',
      )
      assert.deepEqual(await keys(search, query, 'original'), ['a'])
      assert.deepEqual(await keys(search, query, 'replacement'), [])
    },
  },
  {
    name: 'search keeps SQLite prefix and phrase query syntax',
    async run(ctx) {
      if (ctx.adapter.kind !== 'sqlite') return
      const { query, search } = await setup(ctx)
      await search.createIndex(query, definition)
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'a',
        fields: { title: 'quick brown fox', body: '' },
      })
      await search.upsertEntry(query, {
        index: definition.index,
        key: 'b',
        fields: { title: 'quick fox brown', body: '' },
      })
      assert.deepEqual(await keys(search, query, 'quic*'), ['a', 'b'])
      assert.deepEqual(await keys(search, query, '"quick brown"'), ['a'])
    },
  },
  {
    name: 'search validates identifiers and field counts before issuing SQL',
    async run(ctx) {
      const { query, search } = await setup(ctx)
      let statements = 0
      const observed = query.withPlugin({
        transformQuery({ node }) {
          statements++
          return node
        },
        async transformResult({ result }) {
          return result
        },
      })
      for (const index of ['bad-name', 'a.b', '', 'a'.repeat(64), 'fts_bad"']) {
        await assert.rejects(
          () => search.createIndex(observed, { ...definition, index }),
          'Invalid search index',
        )
        await assert.rejects(() => search.dropIndex(observed, { index }), 'Invalid search index')
        await assert.rejects(
          () => search.upsertEntry(observed, { index, key: 'a', fields: { title: 'value' } }),
          'Invalid search index',
        )
        await assert.rejects(
          () => search.removeEntry(observed, { index, key: 'a' }),
          'Invalid search index',
        )
        await assert.rejects(
          () => search.query(observed, { index, query: 'value', limit: 1 }),
          'Invalid search index',
        )
      }
      for (const fields of [
        [],
        Array.from({ length: 500 }, (_, i) => `f${i}`),
        ['bad-name'],
        ['a'.repeat(64)],
        ['rank'],
        ['entry_key'],
        ['rowid'],
        ['Title', 'title'],
        ['title', 'title'],
        ['fts_documents'],
      ]) {
        await assert.rejects(() => search.createIndex(observed, { ...definition, fields }), Error)
      }
      for (const fields of [
        {},
        { rank: 'bad' },
        Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, 'text'])),
      ]) {
        await assert.rejects(
          () => search.upsertEntry(observed, { index: definition.index, key: 'a', fields }),
          Error,
        )
      }
      assert.equal(statements, 0)
    },
  },
  {
    name: 'search accepts 499 fields with at most 500 bound parameters',
    async run(ctx) {
      const { query, search } = await setup(ctx)
      const fields = Object.fromEntries(
        Array.from({ length: 499 }, (_, i) => [`f${i}`, i === 498 ? 'needle' : '']),
      )
      await search.createIndex(query, { ...definition, fields: Object.keys(fields) })
      await search.upsertEntry(query, { index: definition.index, key: 'a', fields })
      assert.deepEqual(await keys(search, query, 'needle'), ['a'])
    },
  },
]

// Drivers without full-text search still conform to the optional adapter contract.
export const searchCases: Array<ConformanceCase> = cases.map((entry) => ({
  name: entry.name,
  async run(ctx) {
    if (ctx.adapter.search === undefined) return
    await entry.run(ctx)
  },
}))
