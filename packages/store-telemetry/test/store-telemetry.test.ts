import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { StoredSpan, TelemetryStore } from '../src/index.js'
import { getTelemetryStore, TELEMETRY_STORE, telemetryStoreDefinition } from '../src/index.js'

let db: HozonDB
let store: TelemetryStore
let adapter: NodeSQLiteAdapter
beforeEach(async () => {
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter })
  db.register(telemetryStoreDefinition)
  store = await getTelemetryStore(db)
})
afterEach(async () => {
  await db.close()
})
function span(patch: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceID: 'trace-one',
    spanID: 'span-one',
    parentSpanID: 'parent',
    name: 'example 日本語 🐈',
    kind: 0,
    startTime: 1.25,
    endTime: 2.75,
    status: { code: 0, message: 'ok' },
    attributes: { nested: [null, true, 1.5, '😀', { text: '漢字' }] },
    events: [{ name: 'event', time: 1.5, attributes: { nested: ['value'] } }],
    links: [{ traceID: 'other-trace', spanID: 'other-span' }],
    ...patch,
  }
}
function mutateNested(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) mutateNested(child)
    value.push('mutated')
  } else if (value != null && typeof value === 'object') {
    for (const child of Object.values(value)) mutateNested(child)
    Object.assign(value, { mutated: true })
  }
}

test('uses a custom table prefix', async () => {
  await db.close()
  adapter = new NodeSQLiteAdapter({ database: ':memory:' })
  db = new HozonDB({ adapter, tablePrefix: 'kubun' })
  db.register(telemetryStoreDefinition)
  store = await getTelemetryStore(db)
  const input = span()
  await store.addSpans([input])
  expect(await store.getSpans('trace-one')).toEqual([input])
  const names = adapter.database
    .prepare('SELECT name FROM sqlite_master ORDER BY name')
    .all()
    .map((row) => row.name)
  expect(names).toEqual(
    expect.arrayContaining(['kubun_spans', 'kubun_spans_trace_start_seq', 'kubun_spans_end_time']),
  )
  const table = adapter.database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kubun_spans'")
    .get()
  expect(table?.sql).toContain('kubun_spans_trace_span')
  expect(await store.deleteBefore(3, { keepTraceIDs: ['trace-one'] })).toBe(0)
  expect(await store.getSpans('trace-one')).toEqual([input])
  expect(await store.deleteBefore(3, { keepTraceIDs: ['other'] })).toBe(1)
  expect(await store.getSpans('trace-one')).toEqual([])
})

test('round-trips fractional times and isolates every nested boundary', async () => {
  const spans = [span()]
  await store.addSpans(spans)
  mutateNested(spans)
  expect(await store.getSpans('trace-one')).toEqual([span()])
  mutateNested(await store.getSpans('trace-one'))
  expect(await store.getSpans('trace-one')).toEqual([span()])
  const patch = span({ name: 'updated' })
  await store.addSpans([patch])
  mutateNested(patch)
  expect(await store.getSpans('trace-one')).toEqual([span({ name: 'updated' })])
})
test('upserts span pairs preserving sequence and orders timestamp ties', async () => {
  await store.addSpans([
    span({ spanID: 'first', startTime: 3 }),
    span({ spanID: 'second', startTime: 1 }),
    span({ spanID: 'third', startTime: 1 }),
  ])
  expect((await store.getSpans('trace-one')).map((value) => value.spanID)).toEqual([
    'second',
    'third',
    'first',
  ])
  const seq = adapter.database.prepare('SELECT seq FROM hozon_spans WHERE span_id = ?').get('first')
  await store.addSpans([
    span({ spanID: 'first', startTime: 1, endTime: 9, name: 'updated' }),
    span({ traceID: 'other', spanID: 'first' }),
  ])
  expect(
    adapter.database
      .prepare('SELECT seq FROM hozon_spans WHERE trace_id = ? AND span_id = ?')
      .get('trace-one', 'first'),
  ).toEqual(seq)
  const result = await store.getSpans('trace-one')
  expect(result.map((value) => value.spanID)).toEqual(['first', 'second', 'third'])
  expect(result[0]).toEqual(span({ spanID: 'first', startTime: 1, endTime: 9, name: 'updated' }))
  expect(await store.getSpans('other')).toEqual([span({ traceID: 'other', spanID: 'first' })])
})
test('upserts duplicate span pairs within one addSpans call in input order', async () => {
  await store.addSpans([
    span({ spanID: 'repeated', name: 'first occurrence' }),
    span({ spanID: 'unrelated', name: 'unrelated' }),
    span({ spanID: 'repeated', name: 'last occurrence' }),
    span({ spanID: 'after', name: 'after duplicate' }),
  ])
  const spans = await store.getSpans('trace-one')
  expect(spans.map((value) => value.spanID)).toEqual(['repeated', 'unrelated', 'after'])
  expect(spans[0]).toEqual(span({ spanID: 'repeated', name: 'last occurrence' }))
})
test('uses strict end-time cutoff, keeps traces and reports actual counts', async () => {
  await store.addSpans([
    span({ traceID: 'old', endTime: 4 }),
    span({ traceID: 'boundary', startTime: 1, endTime: 5 }),
    span({ traceID: 'kept' }),
  ])
  expect(await store.deleteBefore(5, { keepTraceIDs: ['kept', 'kept'] })).toBe(1)
  expect(await store.getSpans('old')).toEqual([])
  for (const id of ['boundary', 'kept']) expect(await store.getSpans(id)).toHaveLength(1)
  expect(await store.deleteByTrace(['kept', 'kept', 'missing'])).toBe(1)
  expect(await store.deleteBefore(6)).toBe(1)
  expect(await store.deleteByTrace(['missing'])).toBe(0)
})
test('handles missing IDs and empty collections without executing SQL', async () => {
  expect(await store.getSpans('missing')).toEqual([])
  await store.addSpans([span()])
  const prepare = vi.spyOn(adapter.database, 'prepare')
  await store.addSpans([])
  expect(await store.deleteByTrace([])).toBe(0)
  expect(prepare).not.toHaveBeenCalled()
  prepare.mockRestore()
  expect(await store.getSpans('trace-one')).toEqual([span()])
  expect(await store.deleteByTrace(['trace-one'])).toBe(1)
})
test('deleteBefore with an empty keep list deletes every older span', async () => {
  await store.addSpans([span({ endTime: 4 }), span({ traceID: 'recent', endTime: 10 })])
  expect(await store.deleteBefore(5, { keepTraceIDs: [] })).toBe(1)
  expect(await store.getSpans('trace-one')).toEqual([])
  expect(await store.getSpans('recent')).toEqual([span({ traceID: 'recent', endTime: 10 })])
})
test('protects a large keep set', async () => {
  await store.addSpans([span(), span({ traceID: 'drop' })])
  const kept = Array.from({ length: 40000 }, (_, index) => `trace-${index}`)
  kept[20000] = 'trace-one'
  expect(await store.deleteBefore(100, { keepTraceIDs: kept })).toBe(1)
  expect(await store.getSpans('trace-one')).toEqual([span()])
})
test('two deleteBefore calls work inside one transaction with duplicate keep IDs', async () => {
  await store.addSpans([span({ traceID: 'a' }), span({ traceID: 'b' }), span({ traceID: 'c' })])
  await db.withTransaction(async (tx) => {
    const scoped = await getTelemetryStore(tx)
    expect(await scoped.deleteBefore(3, { keepTraceIDs: ['a', 'a'] })).toBe(2)
    expect(await scoped.deleteBefore(3, { keepTraceIDs: ['b', 'b'] })).toBe(1)
  })
  expect(await store.getSpans('a')).toEqual([])
})
test('standalone and transactional inserts and deletes commit and roll back', async () => {
  await store.addSpans([span({ traceID: 'a' })])
  await db.withTransaction(async (tx) => {
    const scoped = await getTelemetryStore(tx)
    await scoped.addSpans([span({ traceID: 'b' })])
    expect(await scoped.deleteByTrace(['a'])).toBe(1)
  })
  await expect(
    db.withTransaction(async (tx) => {
      const scoped = await getTelemetryStore(tx)
      await scoped.addSpans([span({ traceID: 'c' })])
      await scoped.deleteByTrace(['b'])
      await scoped.deleteBefore(3, { keepTraceIDs: ['missing'] })
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')
  expect(await store.getSpans('a')).toEqual([])
  expect(await store.getSpans('b')).toEqual([span({ traceID: 'b' })])
  expect(await store.getSpans('c')).toEqual([])
})
test('every statement stays within 500 bound parameters across batches', async () => {
  const prepare = vi.spyOn(adapter.database, 'prepare')
  const ids = Array.from({ length: 1201 }, (_, i) => `trace-${i}`)
  await store.addSpans(ids.map((traceID) => span({ traceID })))
  expect(await store.deleteBefore(3, { keepTraceIDs: [...ids, ...ids] })).toBe(0)
  expect(await store.deleteByTrace([...ids, ...ids])).toBe(1201)
  const counts = prepare.mock.calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)
  expect(Math.max(...counts)).toBe(500)
  expect(counts.filter((count) => count === 500).length).toBeGreaterThan(12)
})
test('later insert failure rolls back earlier batches and upserts', async () => {
  await store.addSpans([span({ spanID: '0', name: 'original' })])
  adapter.database.exec(
    "CREATE TRIGGER fail_span BEFORE INSERT ON hozon_spans WHEN NEW.span_id = '100' BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
  )
  await expect(
    store.addSpans(Array.from({ length: 101 }, (_, i) => span({ spanID: `${i}` }))),
  ).rejects.toThrow('insert failed')
  expect(await store.getSpans('trace-one')).toEqual([span({ spanID: '0', name: 'original' })])
})
test('migration creates the table columns, unique span pair and required indexes', () => {
  expect(TELEMETRY_STORE).toBe('telemetry')
  expect(
    adapter.database
      .prepare('PRAGMA table_info(hozon_spans)')
      .all()
      .map((column) => column.name),
  ).toEqual(['seq', 'trace_id', 'span_id', 'start_time', 'end_time', 'data'])
  for (const [name, expected] of [
    ['hozon_spans_trace_start_seq', ['trace_id', 'start_time', 'seq']],
    ['hozon_spans_end_time', ['end_time']],
  ] as const) {
    expect(
      adapter.database
        .prepare(`PRAGMA index_info(${name})`)
        .all()
        .map((column) => column.name),
    ).toEqual(expected)
  }
  const unique = adapter.database
    .prepare('PRAGMA index_list(hozon_spans)')
    .all()
    .filter((index) => index.unique === 1)
  expect(unique).toHaveLength(1)
  const index = unique[0]
  if (index === undefined) throw new Error('Expected unique index')
  expect(
    adapter.database
      .prepare(`PRAGMA index_info(${index.name})`)
      .all()
      .map((column) => column.name),
  ).toEqual(['trace_id', 'span_id'])
})
