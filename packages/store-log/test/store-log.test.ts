import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { DummyDriver, Kysely, PostgresDialect } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LogStore, StoredLog } from '../src/index.js'
import { getLogStore, isTracedLog, logStoreDefinition } from '../src/index.js'
import { logStoreMigrations } from '../src/migrations.js'

let db: HozonDB
let store: LogStore
let adapter: NodeSQLiteAdapter
beforeEach(async () => {
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter })
  db.register(logStoreDefinition)
  store = await getLogStore(db)
})
afterEach(async () => {
  await db.close()
})
function log(timestamp: number, message = `${timestamp}`, traceID?: string): StoredLog {
  return {
    timestamp,
    message,
    level: 'info',
    category: ['a'],
    properties: {},
    ...(traceID === undefined ? {} : { traceID, spanID: 'span' }),
  }
}

test('empty inputs are no-ops without executing SQL', async () => {
  await store.addLogs([log(1)])
  const prepare = vi.spyOn(adapter.database, 'prepare')
  await store.addLogs([])
  expect(await store.deleteByTrace([])).toBe(0)
  expect(await store.deleteBefore(10, { keepTraceIDs: [] })).toBe(0)
  expect(prepare).not.toHaveBeenCalled()
  prepare.mockRestore()
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([log(1)])
})
test.each([{ traceID: 'trace' }, { spanID: 'span' }])(
  'rejects unpaired IDs %s and writes nothing',
  async (ids) => {
    await expect(store.addLogs([log(1), { ...log(2), ...ids }])).rejects.toThrow(/index 1/)
    expect((await store.queryLogs({ limit: 10 })).logs).toEqual([])
  },
)
test('validates every category before any batch is written', async () => {
  await expect(
    store.addLogs([
      ...Array.from({ length: 80 }, () => log(1)),
      { ...log(2), category: ['bad\u001f'] },
    ]),
  ).rejects.toThrow(TypeError)
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([])
})
test('queryLogs orders by timestamp then insertion sequence', async () => {
  const logs = [log(2), log(1, 'first'), log(1, 'second'), log(0)]
  await store.addLogs(logs)
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([logs[3], logs[1], logs[2], logs[0]])
})
test('cursor paginates equal timestamps without gaps or repeats', async () => {
  const logs = [
    ...Array.from({ length: 5 }, (_, i) => log(1, `a${i}`)),
    ...Array.from({ length: 3 }, (_, i) => log(2, `b${i}`)),
  ]
  await store.addLogs(logs)
  const first = await store.queryLogs({ limit: 3 })
  if (first.cursor === undefined) throw new Error('Expected next page cursor')
  expect(JSON.parse(atob(first.cursor.replaceAll('-', '+').replaceAll('_', '/')))).toEqual([1, 3])
  const second = await store.queryLogs({ limit: 3, cursor: first.cursor })
  const third = await store.queryLogs({ limit: 3, cursor: second.cursor })
  expect([first.logs.length, second.logs.length, third.logs.length]).toEqual([3, 3, 2])
  expect([...first.logs, ...second.logs, ...third.logs]).toEqual(logs)
  expect(third.cursor).toBeUndefined()
})
test('limit is capped at 1000 and inserts are batched', async () => {
  await store.addLogs(Array.from({ length: 1005 }, (_, i) => log(i)))
  const page = await store.queryLogs({ limit: 2000 })
  expect(page.logs).toHaveLength(1000)
  expect((await store.queryLogs({ limit: 2000, cursor: page.cursor })).logs).toHaveLength(5)
})
test('filters inclusive time bounds, levels, category segments and trace', async () => {
  const matching = { ...log(2, 'match', 'trace'), level: 'warning' as const, category: ['a', 'b'] }
  await store.addLogs([
    log(0),
    matching,
    { ...matching, timestamp: 3 },
    { ...matching, timestamp: 4 },
    { ...matching, category: ['ab'] },
    { ...matching, category: ['a.b'] },
    { ...matching, level: 'debug' },
    { ...matching, traceID: 'other' },
  ])
  expect(
    (
      await store.queryLogs({
        from: 2,
        to: 3,
        levels: ['warning'],
        categoryPrefix: ['a'],
        traceID: 'trace',
        limit: 10,
      })
    ).logs,
  ).toEqual([matching, { ...matching, timestamp: 3 }])
  expect((await store.queryLogs({ levels: [], limit: 10 })).logs).toEqual([])
  expect((await store.queryLogs({ categoryPrefix: [], limit: 10 })).logs).toHaveLength(8)
})
test('category prefix includes Unicode descendants and only whole segments', async () => {
  const matching = [['a'], ['a', '😀'], ['a', '\uffff'], ['a', 'b', 'c']].map((category, i) => ({
    ...log(i),
    category,
  }))
  await store.addLogs([
    ...matching,
    ...[['ab'], ['a.b'], ['b'], [], ['😀'], ['\uffff']].map((category, i) => ({
      ...log(i + 4),
      category,
    })),
  ])
  expect((await store.queryLogs({ categoryPrefix: ['a'], limit: 10 })).logs).toEqual(matching)
  expect((await store.queryLogs({ categoryPrefix: [], limit: 10 })).logs).toEqual(
    (await store.queryLogs({ limit: 10 })).logs,
  )
  expect((await store.queryLogs({ categoryPrefix: [], limit: 10 })).logs).toHaveLength(10)
})
test('getTraceLogs returns all trace logs in chronological order', async () => {
  const logs = [log(2, 'late', 'trace'), log(1, 'first', 'trace'), log(1, 'second', 'trace')]
  await store.addLogs([...logs, log(0), log(0, 'other', 'other')])
  const result = await store.getTraceLogs('trace')
  expect(result).toEqual([logs[1], logs[2], logs[0]])
  expect(result.every(isTracedLog)).toBe(true)
  expect(isTracedLog(log(0))).toBe(false)
  expect(isTracedLog({ ...log(0), traceID: 'only' })).toBe(false)
  expect(await store.getTraceLogs('missing')).toEqual([])
})
test('deleteBefore is strict, protects traces and deletes untraced logs', async () => {
  await store.addLogs([log(1), log(1, 'keep', 'keep'), log(1, 'drop', 'drop'), log(2)])
  expect(await store.deleteBefore(2, { keepTraceIDs: ['keep', 'keep'] })).toBe(2)
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([log(1, 'keep', 'keep'), log(2)])
  expect(await store.deleteBefore(2)).toBe(1)
})
test('two deleteBefore calls work inside one transaction', async () => {
  await store.addLogs([log(1, 'a', 'a'), log(1, 'b', 'b'), log(1)])
  await db.withTransaction(async (tx) => {
    const scoped = await getLogStore(tx)
    expect(await scoped.deleteBefore(2, { keepTraceIDs: ['a'] })).toBe(2)
    expect(await scoped.deleteBefore(2, { keepTraceIDs: ['b'] })).toBe(1)
  })
})
test('standalone and transactional inserts and deletes commit and roll back', async () => {
  await store.addLogs([log(1, 'first', 'a')])
  await db.withTransaction(async (tx) => {
    const scoped = await getLogStore(tx)
    await scoped.addLogs([log(2, 'second', 'b')])
    expect(await scoped.deleteByTrace(['a'])).toBe(1)
  })
  await expect(
    db.withTransaction(async (tx) => {
      const scoped = await getLogStore(tx)
      await scoped.addLogs([log(3)])
      await scoped.deleteByTrace(['b'])
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([log(2, 'second', 'b')])
})
test('deletes and protects more than 500 trace IDs with duplicates', async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `trace-${i}`)
  await store.addLogs(ids.map((id) => log(1, id, id)))
  expect(await store.deleteBefore(2, { keepTraceIDs: [...ids, ...ids] })).toBe(0)
  expect(await store.deleteByTrace([...ids, ...ids])).toBe(1201)
})
test('round trips non-ASCII and nested JSON properties', async () => {
  const input = {
    ...log(1),
    category: ['日本語', '😀'],
    message: '漢字 🐈',
    properties: { nested: { list: [null, true, '😀', 1.5] } },
  }
  await store.addLogs([input])
  expect((await store.queryLogs({ limit: 10 })).logs).toEqual([input])
})

test('every statement stays within 500 bound parameters', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const ids = Array.from({ length: 1201 }, (_, i) => `trace-${i}`)
  await store.addLogs(ids.map((id) => log(1, id, id)))
  await store.queryLogs({
    from: 0,
    to: 2,
    levels: Array.from({ length: 600 }, () => 'info'),
    categoryPrefix: ['a'],
    traceID: ids[0],
    limit: 1,
  })
  await store.deleteBefore(2, { keepTraceIDs: [...ids, ...ids] })
  await store.deleteByTrace(ids)
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(Math.max(...counts)).toBe(500)
  expect(counts.filter((count) => count === 426).length).toBeGreaterThan(1)
})
test('later insert failure rolls back earlier batches', async () => {
  adapter.database.exec(
    "CREATE TRIGGER fail_log BEFORE INSERT ON hozon_logs WHEN NEW.timestamp = 80 BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
  )
  await expect(store.addLogs(Array.from({ length: 100 }, (_, i) => log(i)))).rejects.toThrow(
    'insert failed',
  )
  expect((await store.queryLogs({ limit: 100 })).logs).toEqual([])
})
test('getTraceLogs is not capped by the query page size', async () => {
  const logs = Array.from({ length: 1001 }, (_, i) => log(i, `${i}`, 'trace'))
  await store.addLogs(logs)
  expect(await store.getTraceLogs('trace')).toEqual(logs)
})
test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid limit %s',
  async (limit) => {
    await expect(store.queryLogs({ limit })).rejects.toThrow(RangeError)
  },
)
test.each(['bad', btoa('{}'), btoa('[1]'), btoa('[1,"2"]'), btoa('[1,2.5]')])(
  'rejects malformed cursor %s',
  async (cursor) => {
    await expect(store.queryLogs({ limit: 10, cursor })).rejects.toThrow(TypeError)
  },
)
test('migration creates the table columns and required indexes', () => {
  const columns = adapter.database.prepare('PRAGMA table_info(hozon_logs)').all()
  expect(columns.map((column) => column.name)).toEqual([
    'seq',
    'timestamp',
    'level',
    'category',
    'trace_id',
    'span_id',
    'data',
  ])
  for (const [name, expected] of [
    ['hozon_logs_timestamp', ['timestamp']],
    ['hozon_logs_trace_timestamp_seq', ['trace_id', 'timestamp', 'seq']],
    ['hozon_logs_level_timestamp', ['level', 'timestamp']],
  ] as const) {
    const columns = adapter.database.prepare(`PRAGMA index_info(${name})`).all()
    expect(columns.map((column) => column.name)).toEqual(expected)
  }
})
test('Postgres migration gives categories bytewise collation', async () => {
  class CompilationDialect extends PostgresDialect {
    createDriver() {
      return new DummyDriver()
    }
  }
  const queries: Array<string> = []
  const postgres = new Kysely<Record<string, unknown>>({
    dialect: new CompilationDialect({
      pool: async () => {
        throw new Error('No connection')
      },
    }),
    log(event) {
      if (event.level === 'query') queries.push(event.query.sql)
    },
  })
  try {
    const migrations = logStoreMigrations({
      kind: 'postgres',
      types: { ...adapter.types, serial: 'serial', double: 'double precision', json: 'jsonb' },
      functions: adapter.functions,
    })
    const migration = migrations['0-init']
    if (migration === undefined) throw new Error('Expected initial migration')
    await migration.up(postgres)
    expect(queries[0]).toContain('"category" text collate "C" not null')
  } finally {
    await postgres.destroy()
  }
})
