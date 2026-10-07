import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { createQueryId, type Generated, Kysely, sql } from 'kysely'
import { afterEach, expect, test } from 'vitest'

import { TablePrefixPlugin } from '../src/table-prefix.js'

type Tables = {
  logs: { a: number; seq: Generated<number> }
  a: { id: number }
  b: { id: number }
  items: { id: number; value: string }
  'main.logs': { seq: number }
}

const instances: Array<Kysely<Tables>> = []
afterEach(async () => {
  await Promise.all(instances.splice(0).map((db) => db.destroy()))
})

function setup() {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new Kysely<Tables>({
    dialect: adapter.dialect,
    plugins: [new TablePrefixPlugin('kubun')],
  })
  instances.push(db)
  return db
}

test('prefixes select, insert, update, delete', () => {
  const db = setup()
  expect(db.selectFrom('logs').selectAll().compile().sql).toContain('"kubun_logs"')
  expect(db.insertInto('logs').values({ a: 1 }).compile().sql).toContain('"kubun_logs"')
  expect(db.updateTable('logs').set({ a: 1 }).compile().sql).toContain('"kubun_logs"')
  expect(db.deleteFrom('logs').compile().sql).toContain('"kubun_logs"')
})

test('keeps aliases and prefixes qualified columns', () => {
  const db = setup()
  const aliased = db.selectFrom('logs as l').select('l.seq').compile().sql
  expect(aliased).toContain('"kubun_logs" as "l"')
  expect(aliased).toContain('"l"."seq"')
  expect(db.selectFrom('logs').select('logs.seq').compile().sql).toContain('"kubun_logs"."seq"')
})

test('keeps aliases that match a real table name in the current or outer query', () => {
  const db = setup()
  expect(db.selectFrom('logs as logs').select('logs.seq').compile().sql).toBe(
    'select "logs"."seq" from "kubun_logs" as "logs"',
  )
  const query = db
    .selectFrom('logs')
    .select((eb) => eb.selectFrom('a as logs').select('logs.id').as('nested'))
    .select('logs.seq')
    .compile().sql
  expect(query).toContain('(select "logs"."id" from "kubun_a" as "logs") as "nested"')
  expect(query).toContain('"kubun_logs"."seq" from "kubun_logs"')
})

test('prefixes joins', () => {
  const query = setup().selectFrom('a').innerJoin('b', 'a.id', 'b.id').selectAll().compile().sql
  expect(query).toContain('from "kubun_a" inner join "kubun_b"')
  expect(query).toContain('"kubun_a"."id" = "kubun_b"."id"')
})

test('prefixes sql.table in raw templates', () => {
  const db = setup()
  expect(sql`DROP TABLE ${sql.table('keep_log')}`.compile(db).sql).toContain('"kubun_keep_log"')
  expect(sql`CREATE TEMP TABLE ${sql.table('keep_log')} (id TEXT)`.compile(db).sql).toContain(
    '"kubun_keep_log"',
  )
})

test('prefixes schema builder tables but not index names', () => {
  const db = setup()
  expect(db.schema.createTable('logs').addColumn('a', 'integer').compile().sql).toContain(
    '"kubun_logs"',
  )
  const index = db.schema.createIndex('my_idx').on('logs').column('a').compile().sql
  expect(index).toContain('"my_idx"')
  expect(index).toContain('"kubun_logs"')
  expect(index).not.toContain('kubun_my_idx')
  expect(db.schema.dropTable('logs').compile().sql).toContain('"kubun_logs"')
})

test('leaves schema-qualified tables unchanged', () => {
  const db = setup()
  const query = db.selectFrom('main.logs').select('main.logs.seq').compile().sql
  expect(query).toContain('"main"."logs"')
  expect(query).not.toContain('kubun_')
  expect(sql`DROP TABLE ${sql.table('main.logs')}`.compile(db).sql).toBe('DROP TABLE "main"."logs"')
})

test('keeps CTE names and qualifiers while prefixing underlying tables', () => {
  const db = setup()
  const query = db
    .with('recent', (qb) => qb.selectFrom('logs').select('logs.seq'))
    .selectFrom('recent')
    .select('recent.seq')
    .compile().sql
  expect(query).toContain('with "recent" as (select "kubun_logs"."seq" from "kubun_logs")')
  expect(query).toContain('select "recent"."seq" from "recent"')
  expect(query).not.toContain('kubun_recent')
})

test('creates and queries the physical prefixed table', async () => {
  const db = setup()
  await db.schema
    .createTable('items')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .execute()
  await db.insertInto('items').values({ id: 1, value: 'stored' }).execute()
  expect(await db.selectFrom('items').selectAll().execute()).toEqual([{ id: 1, value: 'stored' }])
  const tables = await sql<{
    name: string
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db.withoutPlugins())
  expect(tables.rows).toEqual([{ name: 'kubun_items' }])
})

test('returns the query result unchanged', async () => {
  const result = { rows: [{ seq: 1 }], numAffectedRows: 1n }
  expect(
    await new TablePrefixPlugin('kubun').transformResult({ queryId: createQueryId(), result }),
  ).toBe(result)
})
