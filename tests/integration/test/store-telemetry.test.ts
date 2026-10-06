import { HozonDB } from '@hozon/db'
import {
  getTelemetryStore,
  type TelemetryStore,
  telemetryStoreDefinition,
} from '@hozon/store-telemetry'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'
import { sampleSpan } from '../src/helpers.js'

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const openStore = async (reopen = false): Promise<{ db: HozonDB; store: TelemetryStore }> => {
    const db = new HozonDB({
      adapter: reopen ? await backend.reopen() : await backend.createAdapter(),
    })
    databases.push(db)
    db.register(telemetryStoreDefinition)
    return { db, store: await getTelemetryStore(db) }
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('batch insert stores every span with nested payloads', async () => {
    const { store } = await openStore()
    const spans = Array.from({ length: 250 }, (_, index) =>
      sampleSpan('trace', `span-${index}`, index, {
        ...(index === 0 ? {} : { parentSpanID: 'span-0' }),
        attributes: { index, label: '雪 🐈', nested: { list: [1, null, { ok: true }] } },
        events: [{ name: 'event', time: index + 0.5, attributes: { emoji: '🗄️' } }],
        links: [{ traceID: 'linked', spanID: `link-${index}` }],
      }),
    )
    await store.addSpans(spans)
    expect(await store.getSpans('trace')).toEqual(spans)
  })

  test('addSpans upserts on (traceID, spanID)', async () => {
    const { store } = await openStore()
    await store.addSpans([sampleSpan('trace', 'a', 1), sampleSpan('trace', 'b', 2)])
    const updated = sampleSpan('trace', 'a', 3, { name: 'updated', status: { code: 2 } })
    await store.addSpans([updated, sampleSpan('other', 'a', 1)])
    expect(await store.getSpans('trace')).toEqual([sampleSpan('trace', 'b', 2), updated])
    expect(await store.getSpans('other')).toEqual([sampleSpan('other', 'a', 1)])
  })

  test('a pair repeated in one addSpans call keeps the last occurrence', async () => {
    const { store } = await openStore()
    const last = sampleSpan('trace', 'a', 5, { name: 'last' })
    await store.addSpans([
      sampleSpan('trace', 'a', 1, { name: 'first' }),
      sampleSpan('trace', 'b', 2),
      sampleSpan('trace', 'a', 3, { name: 'middle' }),
      last,
    ])
    expect(await store.getSpans('trace')).toEqual([sampleSpan('trace', 'b', 2), last])
  })

  test('getSpans orders by start time, then insertion', async () => {
    const { store } = await openStore()
    const spans = [
      sampleSpan('trace', 'late', 3),
      sampleSpan('trace', 'tie-1', 2),
      sampleSpan('trace', 'early', 1),
      sampleSpan('trace', 'tie-2', 2),
      sampleSpan('other', 'x', 0),
    ]
    await store.addSpans(spans)
    expect((await store.getSpans('trace')).map((span) => span.spanID)).toEqual([
      'early',
      'tie-1',
      'tie-2',
      'late',
    ])
  })

  test('deleteByTrace removes more than 500 traces', async () => {
    const { store } = await openStore()
    const traceIDs = Array.from({ length: 1_200 }, (_, index) => `trace-${index}`)
    await store.addSpans([
      ...traceIDs.map((traceID) => sampleSpan(traceID, 'root', 1)),
      sampleSpan('survivor', 'root', 1),
    ])
    expect(await store.deleteByTrace(traceIDs)).toBe(1_200)
    expect(await store.getSpans('trace-0')).toEqual([])
    expect(await store.getSpans('trace-1199')).toEqual([])
    expect(await store.getSpans('survivor')).toHaveLength(1)
  })

  test('deleteBefore keeps 40,000 trace IDs', async () => {
    const { store } = await openStore()
    const keepTraceIDs = Array.from({ length: 40_000 }, (_, index) => `keep-${index}`)
    const kept = [...keepTraceIDs.slice(0, 300), keepTraceIDs.at(-1) as string]
    await store.addSpans([
      ...kept.map((traceID) => sampleSpan(traceID, 'root', 1)),
      sampleSpan('drop', 'root', 1),
      sampleSpan('recent', 'root', 10),
    ])
    expect(await store.deleteBefore(5, { keepTraceIDs })).toBe(1)
    expect(await store.getSpans('drop')).toEqual([])
    expect(await store.getSpans('recent')).toHaveLength(1)
    expect(await store.getSpans('keep-39999')).toHaveLength(1)
    expect(await store.deleteBefore(5, { keepTraceIDs: [] })).toBe(0)
    expect(await store.deleteBefore(5)).toBe(kept.length)
  })

  test('spans persist across reopen', async () => {
    const first = await openStore()
    const spans = [sampleSpan('trace', 'a', 1), sampleSpan('trace', 'b', 2)]
    await first.store.addSpans(spans)
    await first.db.close()
    const second = await openStore(true)
    expect(await second.store.getSpans('trace')).toEqual(spans)
  })
})
