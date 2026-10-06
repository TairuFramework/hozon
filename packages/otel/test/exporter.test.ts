import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { context, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, expect, test, vi } from 'vitest'

const { getReporter, report } = vi.hoisted(() => ({ getReporter: vi.fn(), report: vi.fn() }))
vi.mock('@sozai/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sozai/log')>()
  return { ...actual, getReporter }
})

import { HozonDB } from '@hozon/db'
import { getTelemetryStore, telemetryStoreDefinition } from '@hozon/store-telemetry'

import { createTelemetrySpanExporter } from '../src/index.js'

const databases: Array<HozonDB> = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()))
})

async function createStore() {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  databases.push(db)
  db.register(telemetryStoreDefinition)
  return getTelemetryStore(db)
}

test('stores span fields and drains writes on forceFlush', async () => {
  const store = await createStore()
  const exporter = createTelemetrySpanExporter(store)
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const tracer = provider.getTracer('test')
  const parent = tracer.startSpan('parent', { kind: 2, startTime: [1, 0] })
  const child = tracer.startSpan(
    'child',
    {
      startTime: [1, 234_500_000],
      links: [
        {
          context: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            traceFlags: 1,
          },
        },
      ],
    },
    trace.setSpan(context.active(), parent),
  )
  child.setAttribute('answer', 42)
  child.addEvent('finished', { ok: true }, [2, 345_600_000])
  child.setStatus({ code: 2, message: 'failure' })
  child.end([3, 456_700_000])
  parent.end([4, 0])
  await provider.forceFlush()
  const spans = await store.getSpans(child.spanContext().traceId)
  expect(spans).toHaveLength(2)
  expect(spans.find(({ name }) => name === 'child')).toMatchObject({
    parentSpanID: parent.spanContext().spanId,
    kind: 0,
    startTime: 1234.5,
    endTime: 3456.7,
    status: { code: 2, message: 'failure' },
    attributes: { answer: 42 },
    events: [{ name: 'finished', time: 2345.6, attributes: { ok: true } }],
    links: [{ traceID: '0123456789abcdef0123456789abcdef', spanID: '0123456789abcdef' }],
  })
  await provider.shutdown()
})

test('reports failed writes and rejects exports after shutdown', async () => {
  report.mockReset()
  getReporter.mockReset().mockReturnValue(report)
  const exporter = createTelemetrySpanExporter({
    addSpans: vi.fn().mockRejectedValue(new Error('store failed')),
  } as never)
  await new Promise<void>((resolve) => {
    exporter.export([], (result) => {
      expect(result.code).toBe(ExportResultCode.FAILED)
      resolve()
    })
  })
  await exporter.shutdown()
  await new Promise<void>((resolve) => {
    exporter.export([], (result) => {
      expect(result.code).toBe(ExportResultCode.FAILED)
      resolve()
    })
  })
  expect(getReporter).toHaveBeenCalledWith(['hozon', 'otel'], '@hozon/otel')
  expect(report).toHaveBeenCalledWith('Failed to store span batch', expect.any(Error))
})

test('shutdown waits for pending writes before rejecting later exports', async () => {
  let finishWrite: (() => void) | undefined
  let writeFinished = false
  const exporter = createTelemetrySpanExporter({
    addSpans: () =>
      new Promise<void>((resolve) => {
        finishWrite = () => {
          writeFinished = true
          resolve()
        }
      }),
  } as never)
  let exportFinished = false
  exporter.export([], () => {
    exportFinished = true
  })
  await Promise.resolve()
  let shutdownFinished = false
  const shutdown = exporter.shutdown().then(() => {
    shutdownFinished = true
  })
  await Promise.resolve()
  expect(shutdownFinished).toBe(false)
  finishWrite?.()
  await shutdown
  expect(writeFinished).toBe(true)
  expect(exportFinished).toBe(true)
  await new Promise<void>((resolve) => {
    exporter.export([], (result) => {
      expect(result.code).toBe(ExportResultCode.FAILED)
      resolve()
    })
  })
})
