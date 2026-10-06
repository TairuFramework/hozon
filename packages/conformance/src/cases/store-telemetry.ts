import {
  getTelemetryStore,
  type StoredSpan,
  telemetryStoreDefinition,
} from '@hozon/store-telemetry'

import * as assert from '../assert.js'
import type { CaseContext, ConformanceCase } from '../runner.js'

function span(traceID: string, spanID: string, startTime: number): StoredSpan {
  return {
    traceID,
    spanID,
    name: spanID,
    kind: 0,
    startTime,
    endTime: startTime + 1,
    status: { code: 0 },
    attributes: {},
    events: [],
    links: [],
  }
}

export const storeTelemetryCases: Array<ConformanceCase> = [
  {
    name: 'telemetry store: ordering, upserts and trace filters',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(telemetryStoreDefinition)
      const store = await getTelemetryStore(db)
      const inputs = [
        span('trace', 'late', 3),
        span('trace', 'first', 1),
        span('other', 'other', 0),
        span('trace', 'first', 2),
      ]
      await store.addSpans(inputs)
      assert.deepEqual(await store.getSpans('trace'), [inputs[3], inputs[0]])
      assert.deepEqual(await store.getSpans('other'), [inputs[2]])
    },
  },
  {
    name: 'telemetry store: JSON payloads round-trip',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(telemetryStoreDefinition)
      const store = await getTelemetryStore(db)
      const input: StoredSpan = {
        ...span('trace', 'span', 1),
        attributes: { emoji: '🗄️保存', nested: { a: [1, { b: null }] }, long: 'x'.repeat(10_000) },
      }
      await store.addSpans([input])
      assert.deepEqual(await store.getSpans('trace'), [input])
    },
  },
  {
    name: 'telemetry store: duplicate span pairs upsert within one batch',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(telemetryStoreDefinition)
      const store = await getTelemetryStore(db)
      const last = { ...span('trace', 'repeat', 2), name: 'last' }
      await store.addSpans([span('trace', 'repeat', 1), span('trace', 'other', 1), last])
      assert.deepEqual(await store.getSpans('trace'), [span('trace', 'other', 1), last])
    },
  },
  {
    name: 'telemetry store: retention preserves 2,000 trace IDs',
    async run(ctx: CaseContext) {
      const db = ctx.db()
      db.register(telemetryStoreDefinition)
      const store = await getTelemetryStore(db)
      const keepTraceIDs = Array.from({ length: 2_000 }, (_, index) => `keep-${index}`)
      await store.addSpans([
        ...keepTraceIDs.map((traceID) => span(traceID, traceID, 1)),
        span('delete', 'delete', 1),
      ])
      assert.equal(await store.deleteBefore(3, { keepTraceIDs }), 1)
      assert.deepEqual(await store.getSpans('keep-0'), [span('keep-0', 'keep-0', 1)])
      assert.deepEqual(await store.getSpans('delete'), [])
    },
  },
]
