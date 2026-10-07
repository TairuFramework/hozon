import type { ColumnTypes } from '@hozon/adapter'
import type { Kysely } from '@hozon/db'

import * as assert from '../assert.js'
import type { ConformanceCase } from '../runner.js'

type EncodingTables = { conformance_encoding: { value: unknown } }
const values = {
  bigint: 2 ** 53 - 1,
  binary: new Uint8Array([0, 1, 127, 128, 255]),
  boolean: true,
  double: 0.1 + 0.2,
  json: { text: '雪 🐈', nested: { list: [1, null, true, { value: 'é' }] } },
  serial: 1,
  text: '雪 🐈 café',
  timestamp: new Date('2026-01-02T03:04:05.678Z'),
  uuid: '123e4567-e89b-12d3-a456-426614174000',
} satisfies Record<keyof ColumnTypes, unknown>

export const encodingCases: Array<ConformanceCase> = (
  Object.keys(values) as Array<keyof ColumnTypes>
).map((type) => ({
  name: `encoding: ${type} round-trip`,
  async run(ctx) {
    const { adapter } = ctx
    const db = ctx.db()
    db.register<EncodingTables, Kysely<EncodingTables>>({
      name: 'encoding',
      migrations: {
        '0-init': {
          async up(query) {
            await query.schema
              .createTable('conformance_encoding')
              .addColumn('value', adapter.types[type], (column) => {
                if (type !== 'serial') return column
                return adapter.kind === 'sqlite'
                  ? column.primaryKey().autoIncrement()
                  : column.primaryKey()
              })
              .execute()
          },
        },
      },
      createAPI: (query) => query,
    })
    const query = await db.getStore<Kysely<EncodingTables>>('encoding')
    if (type === 'serial') {
      await query.insertInto('conformance_encoding').defaultValues().execute()
      const row = await query
        .selectFrom('conformance_encoding')
        .selectAll()
        .executeTakeFirstOrThrow()
      assert.equal(row.value, 1)
      return
    }
    const inputs = type === 'boolean' ? [true, false] : [values[type]]
    for (const input of inputs) {
      let encoded: unknown = input
      if (type === 'binary') encoded = adapter.encodeBinary(values.binary)
      if (type === 'json') encoded = adapter.encodeJSON(input)
      if (type === 'timestamp') encoded = adapter.encodeTimestamp(values.timestamp)
      await query.insertInto('conformance_encoding').values({ value: encoded }).execute()
      const row = await query
        .selectFrom('conformance_encoding')
        .selectAll()
        .executeTakeFirstOrThrow()
      if (type === 'timestamp') {
        const expected =
          adapter.kind === 'sqlite'
            ? Math.floor(values.timestamp.getTime() / 1000) * 1000
            : values.timestamp.getTime()
        assert.equal(adapter.decodeTimestamp(row.value).getTime(), expected)
      } else if (type === 'boolean') {
        assert.equal(row.value, adapter.kind === 'sqlite' ? (input ? 1 : 0) : input)
        const matching = await query
          .selectFrom('conformance_encoding')
          .selectAll()
          .where('value', '=', adapter.coerceFilterValue(input))
          .execute()
        assert.equal(matching.length, 1)
        const opposite = await query
          .selectFrom('conformance_encoding')
          .selectAll()
          .where('value', '=', adapter.coerceFilterValue(!input))
          .execute()
        assert.equal(opposite.length, 0)
      } else if (type === 'bigint' && adapter.kind === 'postgres') {
        // postgres.js preserves int8 precision by returning text by default.
        assert.equal(String(row.value), String(input))
      } else if (type === 'binary' || type === 'json') {
        assert.deepEqual(row.value, input)
      } else {
        assert.equal(row.value, input)
      }
      await query.deleteFrom('conformance_encoding').execute()
    }
  },
}))
