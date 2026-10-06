import { randomUUID } from 'node:crypto'
import { summarize } from '@hozon/conformance'
import { HozonDB } from '@hozon/db'
import { createLogStoreSink } from '@hozon/logtape'
import { getLogStore, logStoreDefinition } from '@hozon/store-log'
import { getTelemetryStore } from '@hozon/store-telemetry'
import { configure, getLogger } from '@logtape/logtape'
import { trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { runStoreScenario, setupTelemetry } from 'hozon-test-scenarios'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

describe.each(backends())('$name', (backend) => {
  const databases: Array<HozonDB> = []
  const open = async (reopen = false) => {
    const db = new HozonDB({
      adapter: reopen ? await backend.reopen() : await backend.createAdapter(),
    })
    databases.push(db)
    return db
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('store scenario writes, then verifies after reopen', async () => {
    const runID = randomUUID()
    const writer = await open()
    const telemetry = await setupTelemetry({
      contextManager: new AsyncLocalStorageContextManager(),
      db: writer,
    })
    let written: Awaited<ReturnType<typeof runStoreScenario>>
    try {
      written = await runStoreScenario({ db: writer, phase: 'write', runID })
    } finally {
      await telemetry.teardown()
    }
    await writer.close()
    expect(written.filter((result) => !result.ok)).toEqual([])

    const verified = await runStoreScenario({ db: await open(true), phase: 'verify', runID })
    expect(verified.filter((result) => !result.ok)).toEqual([])
    const results = [...written, ...verified]
    expect(summarize(results).line('Stores')).toBe(`Stores: OK ${results.length}/${results.length}`)
  })

  test('logtape sink applies tracedOnly, excludeCategories and hozon self-exclusion', async () => {
    const db = await open()
    db.register(logStoreDefinition)
    const store = await getLogStore(db)
    const telemetry = await setupTelemetry({
      contextManager: new AsyncLocalStorageContextManager(),
      db,
    })
    try {
      const sink = createLogStoreSink(store, {
        tracedOnly: true,
        excludeCategories: [['app', 'noisy']],
      })
      await configure({
        sinks: { hozon: sink },
        loggers: [
          { category: ['app'], sinks: ['hozon'], lowestLevel: 'debug' },
          { category: ['hozon'], sinks: ['hozon'], lowestLevel: 'debug' },
          { category: ['logtape', 'meta'], sinks: [], lowestLevel: 'warning' },
        ],
        reset: true,
      })
      getLogger(['app']).info('untraced, dropped')
      await trace.getTracer('test').startActiveSpan('span', async (span) => {
        getLogger(['app']).info('traced, kept')
        getLogger(['app', 'noisy']).info('excluded category')
        getLogger(['hozon', 'db']).info('self-excluded')
        // The async context follows `await`, so later records stay traced.
        await Promise.resolve()
        getLogger(['app', 'child']).warn('traced after await')
        span.end()
      })
      await sink.flush()
      const { logs } = await store.queryLogs({ limit: 100 })
      expect(logs.map((log) => [log.category, log.message])).toEqual([
        [['app'], 'traced, kept'],
        [['app', 'child'], 'traced after await'],
      ])
      expect(new Set(logs.map((log) => log.traceID)).size).toBe(1)
    } finally {
      await telemetry.teardown()
    }
  })

  test('otel provider shutdown drains pending span writes', async () => {
    const db = await open()
    const telemetry = await setupTelemetry({
      contextManager: new AsyncLocalStorageContextManager(),
      db,
    })
    const span = trace.getTracer('test').startSpan('drained')
    span.setAttribute('emoji', '🛰️')
    span.end()
    await telemetry.teardown()
    const spans = await (await getTelemetryStore(db)).getSpans(span.spanContext().traceId)
    expect(spans.map((stored) => [stored.name, stored.attributes])).toEqual([
      ['drained', { emoji: '🛰️' }],
    ])
  })
})
