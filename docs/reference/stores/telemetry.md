# Telemetry store

`@hozon/store-telemetry` exports `TELEMETRY_STORE`, `telemetryStoreDefinition`, `getTelemetryStore`, `TelemetryTables`, `StoredSpan`, and `TelemetryStore`.

```ts
type StoredSpan = {
  traceID: string; spanID: string; parentSpanID?: string; name: string; kind: number
  startTime: number; endTime: number; status: { code: number; message?: string }
  attributes: Record<string, JSONValue>
  events: Array<{ name: string; time: number; attributes: Record<string, JSONValue> }>
  links: Array<{ traceID: string; spanID: string }>
}
type TelemetryStore = {
  addSpans(spans: Array<StoredSpan>): Promise<void>
  getSpans(traceID: string): Promise<Array<StoredSpan>>
  deleteByTrace(traceIDs: Array<string>): Promise<number>
  deleteBefore(time: number, params?: { keepTraceIDs?: Array<string> }): Promise<number>
}
type TelemetryTables = {
  spans: {
    seq: Generated<number>; trace_id: string; span_id: string; start_time: number
    end_time: number; data: ColumnType<StoredSpan, unknown, unknown>
  }
}
const TELEMETRY_STORE: 'telemetry'
const telemetryStoreDefinition: StoreDefinition<TelemetryTables, TelemetryStore>
function getTelemetryStore(provider: StoreProvider): Promise<TelemetryStore>
```

The `spans` table (default physical name `hozon_spans`) stores `seq`, `trace_id`, `span_id`, `start_time`, `end_time`, and JSON `data`. `(trace_id, span_id)` is unique. Indexes cover trace plus start time and sequence, and end time. `addSpans` upserts on the unique trace/span pair. If one call repeats that pair, the last occurrence's data wins.

Retention and batching rules are shared with the log store; see [Stores](../stores.md#retention-and-batching).
See [log integration](../telemetry.md) for LogTape and OpenTelemetry adapters.
