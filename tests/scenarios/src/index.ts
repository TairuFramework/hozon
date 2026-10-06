import type { ConformanceResult } from '@hozon/conformance'
import type { HozonDB } from '@hozon/db'
import { createLogStoreSink } from '@hozon/logtape'
import { createTelemetrySpanExporter } from '@hozon/otel'
import { getLogStore, type LogStore, logStoreDefinition, type StoredLog } from '@hozon/store-log'
import {
  getTelemetryStore,
  type TelemetryStore,
  telemetryStoreDefinition,
} from '@hozon/store-telemetry'
import { configure, getConsoleSink, getLogger, reset } from '@logtape/logtape'
import { type ContextManager, context, trace } from '@opentelemetry/api'
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

const TRACED_MESSAGES = ['scenario started', 'scenario warning', 'scenario failed'] as const
const UNTRACED_MESSAGE = 'scenario untraced'

type Stores = { log: LogStore; telemetry: TelemetryStore }
type Check = { name: string; run(): Promise<void> }

function fail(message: string): never {
  throw new Error(message)
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJSON = JSON.stringify(actual)
  const expectedJSON = JSON.stringify(expected)
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

function traceChecks(stores: Stores, runID: string, traceID: () => string): Array<Check> {
  return [
    {
      name: 'trace logs: 3 logs in order',
      async run() {
        const logs = await stores.log.getTraceLogs(traceID())
        expectEqual(
          logs.map((entry) => entry.message),
          TRACED_MESSAGES,
          'trace log messages',
        )
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
        expectEqual(
          logs.map((entry) => [entry.message, entry.traceID]),
          [[TRACED_MESSAGES[2], traceID()]],
          'error logs',
        )
      },
    },
    {
      name: 'query logs: untraced log stored',
      async run() {
        const logs = await runLogs(stores.log, runID)
        expectEqual(
          logs.filter((entry) => entry.traceID === undefined).map((entry) => entry.message),
          [UNTRACED_MESSAGE],
          'untraced logs',
        )
        expectEqual(logs.length, 4, 'run log count')
      },
    },
    {
      name: 'spans: 1 span named after the run',
      async run() {
        const spans = await stores.telemetry.getSpans(traceID())
        expectEqual(
          spans.map((span) => span.name),
          [`scenario-${runID}`],
          'span names',
        )
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
          logger.info(TRACED_MESSAGES[0], { runID })
          logger.warn(TRACED_MESSAGES[1], { runID })
          logger.error(TRACED_MESSAGES[2], { runID })
          span.end()
        })
        logger.info(UNTRACED_MESSAGE, { runID })
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
          // `keepTraceIDs: []` is a documented no-op, so retention without keep IDs omits it.
          await stores.log.deleteBefore(Number.POSITIVE_INFINITY)
          await stores.telemetry.deleteBefore(Number.POSITIVE_INFINITY)
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
