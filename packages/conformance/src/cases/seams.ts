import type { ArrayPresenceMode } from '@hozon/adapter'
import { type Kysely, sql } from '@hozon/db'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

type SeamTables = { conformance_seams: { id: number; text: string | null; array: unknown } }
async function setup(ctx: CaseContext): Promise<Kysely<SeamTables>> {
  const db = ctx.db()
  db.register<SeamTables, Kysely<SeamTables>>({
    name: 'seams',
    migrations: {
      '0-init': {
        async up(query) {
          await query.schema
            .createTable('conformance_seams')
            .addColumn('id', 'integer', (column) => column.primaryKey())
            .addColumn('text', ctx.adapter.types.text)
            .addColumn('array', ctx.adapter.types.json)
            .execute()
        },
      },
    },
    createAPI: (query) => query,
  })
  const query = await db.getStore<Kysely<SeamTables>>('seams')
  await query
    .insertInto('conformance_seams')
    .values([
      { id: 1, text: 'ABC', array: ctx.adapter.encodeJSON(['a', 'b', 2]) },
      { id: 2, text: 'xyz', array: ctx.adapter.encodeJSON(['b', 3]) },
      { id: 3, text: null, array: ctx.adapter.encodeJSON([]) },
      { id: 4, text: '10.25', array: null },
    ])
    .execute()
  return query
}

export const seamCases: Array<ConformanceCase> = [
  {
    name: 'seams: contains is ASCII case-insensitive',
    async run(ctx) {
      const query = await setup(ctx)
      // The seam accepts a SQL pattern; wildcards request substring matching.
      const rows = await query
        .selectFrom('conformance_seams')
        .select('id')
        .where(ctx.adapter.containsPredicate(sql.ref('text'), '%b%'))
        .execute()
      assert.deepEqual(
        rows.map((row) => row.id),
        [1],
      )
    },
  },
  {
    name: 'seams: arrays include all string and numeric values',
    async run(ctx) {
      const query = await setup(ctx)
      for (const [values, expected] of [
        [['a', 'b'], [1]],
        [['b', 2], [1]],
        [['missing'], []],
      ] as Array<[Array<unknown>, Array<number>]>) {
        const rows = await query
          .selectFrom('conformance_seams')
          .select('id')
          .where(ctx.adapter.arrayIncludesAllPredicate(sql.ref('array'), values))
          .orderBy('id')
          .execute()
        assert.deepEqual(
          rows.map((row) => row.id),
          expected,
        )
      }
    },
  },
  {
    name: 'seams: arrays include any string and numeric values',
    async run(ctx) {
      const query = await setup(ctx)
      for (const [values, expected] of [
        [
          ['a', 'b'],
          [1, 2],
        ],
        [[2, 9], [1]],
        [['missing'], []],
      ] as Array<[Array<unknown>, Array<number>]>) {
        const rows = await query
          .selectFrom('conformance_seams')
          .select('id')
          .where(ctx.adapter.arrayIncludesAnyPredicate(sql.ref('array'), values))
          .orderBy('id')
          .execute()
        assert.deepEqual(
          rows.map((row) => row.id),
          expected,
        )
      }
    },
  },
  {
    name: 'seams: arrays include any of an empty list matches nothing',
    async run(ctx) {
      const query = await setup(ctx)
      const rows = await query
        .selectFrom('conformance_seams')
        .select('id')
        .where(ctx.adapter.arrayIncludesAnyPredicate(sql.ref('array'), []))
        .orderBy('id')
        .execute()
      assert.deepEqual(
        rows.map((row) => row.id),
        [],
      )
    },
  },
  {
    name: 'seams: arrays include all of an empty list matches every row',
    async run(ctx) {
      const query = await setup(ctx)
      // Vacuous truth, as in SQL/array containment: every array contains the empty set,
      // including a NULL node (treated as an empty array).
      const rows = await query
        .selectFrom('conformance_seams')
        .select('id')
        .where(ctx.adapter.arrayIncludesAllPredicate(sql.ref('array'), []))
        .orderBy('id')
        .execute()
      assert.deepEqual(
        rows.map((row) => row.id),
        [1, 2, 3, 4],
      )
    },
  },
  {
    name: 'seams: arrays include all ignores duplicate values',
    async run(ctx) {
      const query = await setup(ctx)
      for (const [values, expected] of [
        [['a', 'a'], [1]],
        [['b', 'b', 2, 2], [1]],
        [[3, 3, 'b'], [2]],
      ] as Array<[Array<unknown>, Array<number>]>) {
        const rows = await query
          .selectFrom('conformance_seams')
          .select('id')
          .where(ctx.adapter.arrayIncludesAllPredicate(sql.ref('array'), values))
          .orderBy('id')
          .execute()
        assert.deepEqual(
          rows.map((row) => row.id),
          expected,
        )
      }
    },
  },
  ...Object.entries({
    null: [4],
    nonNull: [1, 2, 3],
    empty: [3],
    nonEmpty: [1, 2],
    nullOrEmpty: [3, 4],
  }).map(
    ([mode, expected]): ConformanceCase => ({
      name: `seams: array presence ${mode}`,
      async run(ctx) {
        const query = await setup(ctx)
        const rows = await query
          .selectFrom('conformance_seams')
          .select('id')
          .where(ctx.adapter.arrayPresencePredicate(sql.ref('array'), mode as ArrayPresenceMode))
          .orderBy('id')
          .execute()
        assert.deepEqual(
          rows.map((row) => row.id),
          expected,
        )
      },
    }),
  ),
  {
    name: 'seams: ascending ordering puts nulls last',
    async run(ctx) {
      const query = await setup(ctx)
      const term = ctx.adapter.nullOrdering(sql.ref('text'), 'asc')
      let select = query.selectFrom('conformance_seams').select('id')
      if (term.kind === 'lead') select = select.orderBy(term.expression, 'asc')
      const rows = await select.orderBy('text', 'asc').execute()
      assert.deepEqual(
        rows.map((row) => row.id),
        [4, 1, 2, 3],
      )
    },
  },
  {
    name: 'seams: numeric cast returns a number',
    async run(ctx) {
      const query = await setup(ctx)
      const row = await query
        .selectFrom('conformance_seams')
        .select(sql<number>`${ctx.adapter.numericCast(sql.ref('text'))}`.as('value'))
        .where('id', '=', 4)
        .executeTakeFirstOrThrow()
      assert.equal(typeof row.value, 'number')
      assert.equal(row.value, 10.25)
    },
  },
]
