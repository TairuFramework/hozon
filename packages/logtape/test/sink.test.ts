import type { LogStore, StoredLog } from '@hozon/store-log'
import type { LogRecord } from '@logtape/logtape'
import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const { getReporter, report } = vi.hoisted(() => ({ getReporter: vi.fn(), report: vi.fn() }))
vi.mock('@sozai/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sozai/log')>()
  return { ...actual, getReporter }
})

import { createLogStoreSink } from '../src/index.js'

let batches: Array<Array<StoredLog>>
let store: LogStore
let provider: BasicTracerProvider
let manager: AsyncLocalStorageContextManager

beforeEach(() => {
  batches = []
  store = {
    addLogs: vi.fn(async (logs) => {
      batches.push(logs)
    }),
  } as unknown as LogStore
  provider = new BasicTracerProvider()
  manager = new AsyncLocalStorageContextManager()
  context.setGlobalContextManager(manager.enable())
  trace.setGlobalTracerProvider(provider)
  report.mockReset()
  getReporter.mockReset().mockReturnValue(report)
})

afterEach(() => {
  manager.disable()
  context.disable()
  trace.disable()
})

function record(category: Array<string> = ['app']): LogRecord {
  return {
    category,
    timestamp: 1234,
    level: 'info',
    rawMessage: 'hello world',
    message: ['hello ', 'world'],
    properties: { count: 2, nested: { ok: true } },
  }
}

function inSpan<T>(fn: () => T): T {
  return trace.getTracer('test').startActiveSpan('test', (span) => {
    try {
      return fn()
    } finally {
      span.end()
    }
  })
}

test('stores records with category, level, rendered message, and JSON properties', async () => {
  const sink = createLogStoreSink(store)
  sink(record())
  await sink.flush()
  expect(batches.flat()).toEqual([
    {
      timestamp: 1234,
      level: 'info',
      category: ['app'],
      message: 'hello world',
      properties: { count: 2, nested: { ok: true } },
    },
  ])
})

test('stores untraced records without trace fields by default', async () => {
  const sink = createLogStoreSink(store)
  sink(record())
  await sink.flush()
  expect(batches.flat()[0]).not.toHaveProperty('traceID')
  expect(batches.flat()[0]).not.toHaveProperty('spanID')
})

test('tracedOnly drops records without an active span', async () => {
  const sink = createLogStoreSink(store, { tracedOnly: true })
  sink(record())
  await sink.flush()
  expect(batches).toEqual([])
})

test('excludeCategories drops matching prefixes', async () => {
  const sink = createLogStoreSink(store, { excludeCategories: [['app', 'internal']] })
  sink(record(['app', 'internal', 'child']))
  sink(record(['app', 'other']))
  await sink.flush()
  expect(batches.flat().map(({ category }) => category)).toEqual([['app', 'other']])
})

test('always excludes the hozon category root', async () => {
  const sink = createLogStoreSink(store)
  sink(record(['hozon', 'db']))
  await sink.flush()
  expect(batches).toEqual([])
})

test('reports store failures, resolves flush, and drains later records', async () => {
  store.addLogs = vi.fn().mockRejectedValueOnce(new Error('closed')).mockResolvedValue(undefined)
  const sink = createLogStoreSink(store)
  sink(record())
  await sink.flush()
  expect(getReporter).toHaveBeenCalledWith(['hozon', 'logtape'], '@hozon/logtape')
  expect(report).toHaveBeenCalledWith('Failed to store log batch', expect.any(Error))
  sink(record(['app', 'later']))
  await sink.flush()
  expect(store.addLogs).toHaveBeenCalledTimes(2)
})

test('attaches the active trace and span IDs', async () => {
  const sink = createLogStoreSink(store)
  inSpan(() => sink(record()))
  await sink.flush()
  const stored = batches.flat()[0]
  expect(stored?.traceID).toMatch(/^[a-f0-9]{32}$/)
  expect(stored?.spanID).toMatch(/^[a-f0-9]{16}$/)
})
