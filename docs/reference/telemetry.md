# Telemetry integrations

## LogTape

`@hozon/logtape` exports `CreateLogStoreSinkParams` and `createLogStoreSink(store, params?)`. Parameters include `tracedOnly` and `excludeCategories`. The sink batches records asynchronously and exposes `flush(): Promise<void>`. It always excludes the `['hozon']` category prefix to prevent recursive logging. Store write failures go to Hozon's reporter.

```ts
type CreateLogStoreSinkParams = {
  tracedOnly?: boolean
  excludeCategories?: Array<Array<string>>
}
function createLogStoreSink(
  store: LogStore,
  params?: CreateLogStoreSinkParams,
): Sink & { flush(): Promise<void> }
```

```ts
import { configureSync, getLogger } from '@logtape/logtape'
import { createLogStoreSink } from '@hozon/logtape'

const sink = createLogStoreSink(logStore)
configureSync({ sinks: { hozon: sink }, loggers: [{ category: [], sinks: ['hozon'], lowestLevel: 'info' }] })
getLogger(['app']).info('Ready')
await sink.flush()
```

## OpenTelemetry

`@hozon/otel` exports `createTelemetrySpanExporter(store)`, which returns a `SpanExporter`. It converts spans to `StoredSpan` and drains pending writes on `forceFlush()` and `shutdown()`.

```ts
function createTelemetrySpanExporter(store: TelemetryStore): SpanExporter
```

A `BasicTracerProvider` alone does not provide an active span context. Register a context manager and provider globally before emitting traced logs. Use `AsyncLocalStorageContextManager` in Node, Electron main, and integration tests. Use `StackContextManager` in browsers and Expo only when logs are emitted synchronously inside `tracer.startActiveSpan` callbacks; it does not preserve context across `await`. Unregister global state with `trace.disable()` and `context.disable()` during teardown.

See [store schemas and retention](stores.md) and the [driver reference](drivers.md).
