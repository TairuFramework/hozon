import type { LogStore, StoredLog } from '@hozon/store-log'
import type { LogRecord, Sink } from '@logtape/logtape'
import { isSpanContextValid, trace } from '@opentelemetry/api'
import type { JSONValue } from '@sozai/json'
import { toJSONValue } from '@sozai/json'
import { getReporter, renderLogMessage } from '@sozai/log'

export type CreateLogStoreSinkParams = {
  tracedOnly?: boolean
  excludeCategories?: Array<Array<string>>
}

export function createLogStoreSink(
  store: LogStore,
  params: CreateLogStoreSinkParams = {},
): Sink & { flush(): Promise<void> } {
  const excluded = [['hozon'], ...(params.excludeCategories ?? [])]
  const tracedOnly = params.tracedOnly ?? false
  const report = getReporter(['hozon', 'logtape'], '@hozon/logtape')
  const queue: Array<StoredLog> = []
  const waiters: Array<() => void> = []
  let writing = false

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0)
      try {
        await store.addLogs(batch)
      } catch (error) {
        report('Failed to store log batch', error)
      }
    }
    writing = false
    for (const resolve of waiters.splice(0)) resolve()
  }

  const sink = (record: LogRecord): void => {
    if (excluded.some((prefix) => prefix.every((part, index) => record.category[index] === part))) {
      return
    }
    const spanContext = trace.getActiveSpan()?.spanContext()
    const validSpanContext =
      spanContext !== undefined && isSpanContextValid(spanContext) ? spanContext : undefined
    if (tracedOnly && validSpanContext === undefined) return

    const log: StoredLog = {
      timestamp: record.timestamp,
      level: record.level,
      category: [...record.category],
      message: renderLogMessage(record),
      properties: Object.fromEntries(
        Object.entries(record.properties).map(([key, value]) => [key, toJSONValue(value)]),
      ) as Record<string, JSONValue>,
      ...(validSpanContext === undefined
        ? {}
        : { traceID: validSpanContext.traceId, spanID: validSpanContext.spanId }),
    }
    queue.push(log)
    if (!writing) {
      writing = true
      queueMicrotask(() => {
        void drain()
      })
    }
  }

  sink.flush = (): Promise<void> => {
    if (!writing && queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => waiters.push(resolve))
  }
  return sink
}
