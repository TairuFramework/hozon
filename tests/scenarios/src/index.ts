import type { ConformanceResult } from '@hozon/conformance'
import type { HozonDB } from '@hozon/db'
import { createLogStoreSink } from '@hozon/logtape'
import { createTelemetrySpanExporter } from '@hozon/otel'
import {
  getLogStore,
  type LogLevel,
  type LogStore,
  logStoreDefinition,
  type StoredLog,
} from '@hozon/store-log'
import {
  getTelemetryStore,
  type StoredSpan,
  type TelemetryStore,
  telemetryStoreDefinition,
} from '@hozon/store-telemetry'
import { configure, getConsoleSink, getLogger, reset } from '@logtape/logtape'
import { type ContextManager, context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'

export type ScenarioPhase = 'write' | 'verify'

export type RunStoreScenarioParams = {
  db: HozonDB
  phase: ScenarioPhase
  runID: string
}

export type SetupTelemetryParams = {
  contextManager: ContextManager
  db: HozonDB
}

export type Telemetry = {
  provider: BasicTracerProvider
  teardown(): Promise<void>
}

type ExpectedLog = { level: LogLevel; message: string; step: number }

// Deterministic payloads, checked field by field in both phases so verify detects corruption.
const PAYLOAD = { text: '雪 🦊 café', nested: { list: [1, null, true, { deep: 'é' }] } }
const TRACED_LOGS: Array<ExpectedLog> = [
  { level: 'info', message: 'scenario started', step: 1 },
  { level: 'warning', message: 'scenario warning', step: 2 },
  { level: 'error', message: 'scenario failed', step: 3 },
]
const UNTRACED_LOG: ExpectedLog = { level: 'info', message: 'scenario untraced', step: 4 }
const SPAN_EVENT = { name: 'scenario.event', attributes: { step: 2 } }

function logProperties(runID: string, step: number) {
  return { runID, step, payload: PAYLOAD }
}

function spanAttributes(runID: string) {
  return { 'scenario.run_id': runID, 'scenario.tags': ['log', '🦊'], 'scenario.count': 3 }
}

type Stores = { log: LogStore; telemetry: TelemetryStore }
type Check = { name: string; run(): Promise<void> }

function fail(message: string): never {
  throw new Error(message)
}

/** Key-order independent JSON (Postgres jsonb does not preserve key order). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  }
  return value
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJSON = JSON.stringify(canonical(actual))
  const expectedJSON = JSON.stringify(canonical(expected))
  if (actualJSON !== expectedJSON)
    fail(`${label}: expected ${expectedJSON}, received ${actualJSON}`)
}

async function getStores(db: HozonDB): Promise<Stores> {
  db.register(logStoreDefinition)
  db.register(telemetryStoreDefinition)
  return { log: await getLogStore(db), telemetry: await getTelemetryStore(db) }
}

async function runChecks(checks: Array<Check>): Promise<Array<ConformanceResult>> {
  const results: Array<ConformanceResult> = []
  for (const check of checks) {
    try {
      await check.run()
      results.push({ name: check.name, ok: true })
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

/** Queries every scenario log of the run, traced and untraced, in chronological order. */
async function runLogs(log: LogStore, runID: string): Promise<Array<StoredLog>> {
  return (await log.queryLogs({ categoryPrefix: ['scenario', runID], limit: 100 })).logs
}

function findTraceID(logs: Array<StoredLog>): string {
  return logs.find((entry) => entry.traceID !== undefined)?.traceID ?? fail('No traced log found')
}

function expectLog(entry: StoredLog, expected: ExpectedLog, runID: string): void {
  expectEqual(
    {
      level: entry.level,
      category: entry.category,
      message: entry.message,
      properties: entry.properties,
    },
    {
      level: expected.level,
      category: ['scenario', runID],
      message: expected.message,
      properties: logProperties(runID, expected.step),
    },
    `log "${expected.message}"`,
  )
  if (!Number.isFinite(entry.timestamp)) fail(`log "${expected.message}": invalid timestamp`)
}

function traceChecks(stores: Stores, runID: string, traceID: () => string): Array<Check> {
  return [
    {
      name: 'trace logs: 3 logs in order with payloads',
      async run() {
        const logs = await stores.log.getTraceLogs(traceID())
        expectEqual(logs.length, TRACED_LOGS.length, 'trace log count')
        logs.forEach((entry, index) => {
          expectLog(entry, TRACED_LOGS[index] as ExpectedLog, runID)
        })
        const spanIDs = new Set(logs.map((entry) => entry.spanID))
        expectEqual(spanIDs.size, 1, 'trace log span IDs')
      },
    },
    {
      name: 'query logs: error level',
      async run() {
        const { logs } = await stores.log.queryLogs({
          categoryPrefix: ['scenario', runID],
          levels: ['error'],
          limit: 100,
        })
        expectEqual(logs.length, 1, 'error log count')
        expectLog(logs[0] as StoredLog, TRACED_LOGS[2] as ExpectedLog, runID)
        expectEqual(logs[0]?.traceID, traceID(), 'error log trace ID')
      },
    },
    {
      name: 'query logs: untraced log stored, timestamps ordered',
      async run() {
        const logs = await runLogs(stores.log, runID)
        expectEqual(logs.length, 4, 'run log count')
        const untraced = logs.filter((entry) => entry.traceID === undefined)
        expectEqual(untraced.length, 1, 'untraced log count')
        expectLog(untraced[0] as StoredLog, UNTRACED_LOG, runID)
        if (untraced[0]?.spanID !== undefined) fail('untraced log has a span ID')
        // Chronological order: the untraced log was emitted after the span's logs.
        expectEqual(logs.at(-1)?.message, UNTRACED_LOG.message, 'last run log')
        const timestamps = logs.map((entry) => entry.timestamp)
        if (timestamps.some((time, index) => index > 0 && time < (timestamps[index - 1] ?? 0))) {
          fail(`log timestamps out of order: ${JSON.stringify(timestamps)}`)
        }
      },
    },
    {
      name: 'spans: 1 span with attributes, status and event',
      async run() {
        const spans = await stores.telemetry.getSpans(traceID())
        expectEqual(spans.length, 1, 'span count')
        const span = spans[0] as StoredSpan
        const logs = await stores.log.getTraceLogs(traceID())
        expectEqual(
          {
            traceID: span.traceID,
            name: span.name,
            kind: span.kind,
            parentSpanID: span.parentSpanID ?? null,
            status: span.status,
            attributes: span.attributes,
            events: span.events.map((event) => ({
              name: event.name,
              attributes: event.attributes,
            })),
            links: span.links,
          },
          {
            traceID: traceID(),
            name: `scenario-${runID}`,
            kind: SpanKind.INTERNAL,
            parentSpanID: null,
            status: { code: SpanStatusCode.OK },
            attributes: spanAttributes(runID),
            events: [SPAN_EVENT],
            links: [],
          },
          'span',
        )
        expectEqual(
          logs.map((entry) => entry.spanID),
          logs.map(() => span.spanID),
          'log span IDs',
        )
        if (!(Number.isFinite(span.startTime) && span.endTime >= span.startTime)) {
          fail(`span times invalid: ${span.startTime}..${span.endTime}`)
        }
      },
    },
  ]
}

async function writePhase(db: HozonDB, runID: string): Promise<Array<ConformanceResult>> {
  const stores = await getStores(db)
  let traceID: string | undefined
  const setup = await runChecks([
    {
      name: 'write: emit logs and span',
      async run() {
        const sink = createLogStoreSink(stores.log, { tracedOnly: false })
        await configure({
          sinks: { console: getConsoleSink(), hozon: sink },
          loggers: [
            { category: ['scenario'], sinks: ['hozon'], lowestLevel: 'debug' },
            { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
          ],
          reset: true,
        })
        const logger = getLogger(['scenario', runID])
        const tracer = trace.getTracer('hozon-test-scenarios')
        tracer.startActiveSpan(`scenario-${runID}`, (span) => {
          traceID = span.spanContext().traceId
          span.setAttributes(spanAttributes(runID))
          for (const expected of TRACED_LOGS) {
            logger[expected.level === 'warning' ? 'warn' : expected.level](
              expected.message,
              logProperties(runID, expected.step),
            )
            if (expected.step === SPAN_EVENT.attributes.step) {
              span.addEvent(SPAN_EVENT.name, SPAN_EVENT.attributes)
            }
          }
          span.setStatus({ code: SpanStatusCode.OK })
          span.end()
        })
        logger.info(UNTRACED_LOG.message, logProperties(runID, UNTRACED_LOG.step))
        await sink.flush()
        // The global provider is a proxy; flush the registered delegate (see setupTelemetry).
        const provider = trace.getTracerProvider() as { getDelegate?: () => unknown }
        const delegate = (provider.getDelegate?.() ?? provider) as {
          forceFlush?: () => Promise<void>
        }
        if (typeof delegate.forceFlush !== 'function')
          fail('No flushable tracer provider registered')
        await delegate.forceFlush()
      },
    },
  ])
  if (!setup[0]?.ok) return setup
  return [
    ...setup,
    ...(await runChecks(traceChecks(stores, runID, () => traceID ?? fail('No trace ID')))),
  ]
}

async function verifyPhase(db: HozonDB, runID: string): Promise<Array<ConformanceResult>> {
  const stores = await getStores(db)
  let traceID: string | undefined
  const found = await runChecks([
    {
      name: 'verify: run logs persisted',
      async run() {
        traceID = findTraceID(await runLogs(stores.log, runID))
      },
    },
  ])
  if (!found[0]?.ok) return found
  const checks = traceChecks(stores, runID, () => traceID ?? fail('No trace ID'))
  return [
    ...found,
    ...(await runChecks([
      ...checks,
      {
        name: 'retention: deleteBefore empties both stores',
        async run() {
          await stores.log.deleteBefore(Number.POSITIVE_INFINITY, { keepTraceIDs: [] })
          await stores.telemetry.deleteBefore(Number.POSITIVE_INFINITY, { keepTraceIDs: [] })
          expectEqual((await stores.log.queryLogs({ limit: 1 })).logs, [], 'remaining logs')
          expectEqual(
            await stores.telemetry.getSpans(traceID ?? fail('No trace ID')),
            [],
            'remaining spans',
          )
        },
      },
    ])),
  ]
}

/**
 * Runs the shared store scenario. The caller registers a tracer provider and context
 * manager globally first (see `setupTelemetry`); `write` and `verify` run against the same
 * database, typically across a reopen, reload or restart.
 */
export async function runStoreScenario(
  params: RunStoreScenarioParams,
): Promise<Array<ConformanceResult>> {
  return params.phase === 'write'
    ? await writePhase(params.db, params.runID)
    : await verifyPhase(params.db, params.runID)
}

/** Registers `contextManager` and a provider exporting to the database's telemetry store. */
export async function setupTelemetry(params: SetupTelemetryParams): Promise<Telemetry> {
  const { telemetry } = await getStores(params.db)
  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(createTelemetrySpanExporter(telemetry))],
  })
  context.setGlobalContextManager(params.contextManager.enable())
  trace.setGlobalTracerProvider(provider)
  return {
    provider,
    async teardown() {
      try {
        await provider.shutdown()
      } finally {
        trace.disable()
        context.disable()
        await reset()
      }
    },
  }
}
