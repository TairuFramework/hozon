import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { Kysely, sql } from 'kysely'
import { afterEach, expect, test } from 'vitest'

import { chunk, withKeepSet } from '../src/index.js'

const instances: Array<Kysely<Record<string, unknown>>> = []
afterEach(async () => {
  await Promise.all(instances.splice(0).map((db) => db.destroy()))
})
function setup(bindCounts: Array<number> = []) {
  const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  const db = new Kysely<Record<string, unknown>>({
    dialect: adapter.dialect,
    log: (event) => {
      if (event.level === 'query') bindCounts.push(event.query.parameters.length)
    },
  })
  instances.push(db)
  return db
}

test.each([
  [0, []],
  [500, [500]],
  [501, [500, 1]],
])('chunk boundaries: %s', (length, sizes) => {
  const items = Array.from({ length: length as number }, (_, i) => i)
  const chunks = chunk(items)
  expect(chunks.map((part) => part.length)).toEqual(sizes)
  expect(chunks.flat()).toEqual(items)
})

test('chunk supports a custom size', () => {
  expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
})

test('withKeepSet deduplicates 1201 ids and drops the table between calls', async () => {
  const bindCounts: Array<number> = []
  const db = setup(bindCounts)
  const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
  await db.transaction().execute(async (trx) => {
    const rows = await withKeepSet(
      trx,
      { table: 'hozon_keep_log', ids: [...ids, ...ids.slice(0, 201)] },
      async (selectKeep) => selectKeep().execute(),
    )
    expect(rows).toHaveLength(1000)
    expect(bindCounts.filter((count) => count > 0)).toEqual([500, 500, 201])
    expect(new Set(rows.map((row) => row.trace_id))).toEqual(new Set(ids))
    await expect(sql`SELECT * FROM ${sql.table('hozon_keep_log')}`.execute(trx)).rejects.toThrow(
      'no such table',
    )
    const empty = await withKeepSet(trx, { table: 'hozon_keep_log', ids: [] }, async (selectKeep) =>
      selectKeep().execute(),
    )
    expect(empty).toEqual([])
    await expect(sql`SELECT * FROM ${sql.table('hozon_keep_log')}`.execute(trx)).rejects.toThrow(
      'no such table',
    )
  })
})

test('withKeepSet drops the table when its callback throws', async () => {
  await setup()
    .transaction()
    .execute(async (trx) => {
      await expect(
        withKeepSet(trx, { table: 'hozon_keep_log', ids: ['a'] }, async () => {
          throw new Error('callback failed')
        }),
      ).rejects.toThrow('callback failed')
      await expect(sql`SELECT * FROM ${sql.table('hozon_keep_log')}`.execute(trx)).rejects.toThrow(
        'no such table',
      )
    })
})

test('withKeepSet rejects calls outside a transaction', async () => {
  await expect(
    withKeepSet(setup(), { table: 'hozon_keep_log', ids: [] }, async () => {}),
  ).rejects.toThrow('transaction')
})

test.each([new Error('callback failed'), undefined])(
  'withKeepSet preserves callback failure %s when cleanup also fails',
  async (original) => {
    await setup()
      .transaction()
      .execute(async (trx) => {
        await expect(
          withKeepSet(trx, { table: 'hozon_keep_log', ids: [] }, async () => {
            await sql`DROP TABLE ${sql.table('hozon_keep_log')}`.execute(trx)
            throw original
          }),
        ).rejects.toBe(original)
      })
  },
)

test('withKeepSet propagates cleanup failure when the callback succeeds', async () => {
  await setup()
    .transaction()
    .execute(async (trx) => {
      await expect(
        withKeepSet(trx, { table: 'hozon_keep_log', ids: [] }, async () => {
          await sql`DROP TABLE ${sql.table('hozon_keep_log')}`.execute(trx)
          return 'success'
        }),
      ).rejects.toThrow('no such table')
    })
})

test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
  'chunk rejects invalid size %s',
  (size) => {
    expect(() => chunk([1], size)).toThrow(RangeError)
  },
)

test('selectKeep can be used as a deletion subquery', async () => {
  const db = setup()
  await db.schema.createTable('logs').addColumn('trace_id', 'text').execute()
  await sql`INSERT INTO logs (trace_id) VALUES ('keep'), ('drop')`.execute(db)
  await db.transaction().execute(async (trx) => {
    await withKeepSet(trx, { table: 'hozon_keep_log', ids: ['keep'] }, async (selectKeep) => {
      await sql`DELETE FROM logs WHERE trace_id NOT IN (${selectKeep()})`.execute(trx)
    })
  })
  expect((await sql<{ trace_id: string }>`SELECT trace_id FROM logs`.execute(db)).rows).toEqual([
    { trace_id: 'keep' },
  ])
})

test('withKeepSet serializes concurrent calls per transaction and table', async () => {
  await setup()
    .transaction()
    .execute(async (trx) => {
      const order: Array<string> = []
      const results = await Promise.all(
        [['a'], ['b', 'c']].map((ids, index) =>
          withKeepSet(trx, { table: 'hozon_keep_log', ids }, async (selectKeep) => {
            order.push(`start-${index}`)
            const rows = await selectKeep().execute()
            order.push(`end-${index}`)
            return rows.map((row) => row.trace_id).sort()
          }),
        ),
      )
      expect(results).toEqual([['a'], ['b', 'c']])
      expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1'])
    })
})

test('withKeepSet releases the table to a queued call after a failure', async () => {
  await setup()
    .transaction()
    .execute(async (trx) => {
      const [first, second] = await Promise.allSettled([
        withKeepSet(trx, { table: 'hozon_keep_log', ids: ['a'] }, async () => {
          throw new Error('callback failed')
        }),
        withKeepSet(trx, { table: 'hozon_keep_log', ids: ['b'] }, async (selectKeep) =>
          selectKeep().execute(),
        ),
      ])
      expect(first).toMatchObject({ status: 'rejected', reason: new Error('callback failed') })
      expect(second).toEqual({ status: 'fulfilled', value: [{ trace_id: 'b' }] })
      await expect(sql`SELECT * FROM ${sql.table('hozon_keep_log')}`.execute(trx)).rejects.toThrow(
        'no such table',
      )
    })
})

test('withKeepSet runs different tables independently', async () => {
  await setup()
    .transaction()
    .execute(async (trx) => {
      const [log, telemetry] = await Promise.all([
        withKeepSet(trx, { table: 'hozon_keep_log', ids: ['a'] }, async (selectKeep) =>
          selectKeep().execute(),
        ),
        withKeepSet(trx, { table: 'hozon_keep_telemetry', ids: ['b'] }, async (selectKeep) =>
          selectKeep().execute(),
        ),
      ])
      expect(log).toEqual([{ trace_id: 'a' }])
      expect(telemetry).toEqual([{ trace_id: 'b' }])
    })
})
