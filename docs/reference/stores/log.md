# Log store

`@hozon/store-log` exports `LOG_STORE`, `logStoreDefinition`, `getLogStore`, `LogTables`, `LogLevel`, `StoredLog`, `TracedLog`, `QueryLogsParams`, `LogStore`, `isTracedLog`, `encodeCategory`, and `categoryRange`.

```ts
type StoredLog = {
  traceID?: string; spanID?: string; timestamp: number; level: LogLevel
  category: Array<string>; message: string; properties: Record<string, JSONValue>
}
type TracedLog = StoredLog & { traceID: string; spanID: string }
type QueryLogsParams = {
  from?: number; to?: number; levels?: Array<LogLevel>; categoryPrefix?: Array<string>
  traceID?: string; limit: number; cursor?: string
}
type LogStore = {
  addLogs(logs: Array<StoredLog>): Promise<void>
  queryLogs(params: QueryLogsParams): Promise<{ logs: Array<StoredLog>; cursor?: string }>
  getTraceLogs(traceID: string): Promise<Array<TracedLog>>
  deleteByTrace(traceIDs: Array<string>): Promise<number>
  deleteBefore(time: number, params?: { keepTraceIDs?: Array<string> }): Promise<number>
}
type LogTables = {
  logs: {
    seq: Generated<number>; timestamp: number; level: LogLevel; category: string
    trace_id: string | null; span_id: string | null; data: ColumnType<StoredLog, unknown, unknown>
  }
}
const LOG_STORE: 'log'
const logStoreDefinition: StoreDefinition<LogTables, LogStore>
function getLogStore(provider: StoreProvider): Promise<LogStore>
function isTracedLog(log: StoredLog): log is TracedLog
function encodeCategory(segments: Array<string>): string
function categoryRange(prefix: Array<string>): { gte: string; lt: string }
```

The `logs` table (default physical name `hozon_logs`) has columns are `seq` (serial primary key), `timestamp` (double), `level`, `category`, nullable `trace_id` and `span_id`, and JSON `data`. Indexes cover timestamp, trace plus timestamp and sequence, and level plus timestamp. Trace and span IDs must be both present or both absent. `addLogs` validates the whole batch before writing.

Category segments are joined with U+001F and a trailing U+001F. For example, `['a', 'b']` encodes as `a\u001fb\u001f`, while `['a.b']` encodes as `a.b\u001f`. Segments containing U+001F are rejected. Prefix queries use a lexicographic range; PostgreSQL's `category` column uses `COLLATE "C"` for correct prefix ordering.

`queryLogs` orders by `(timestamp, seq)`. Its opaque URL-safe base64 cursor encodes that pair and continues strictly after it. Limits are required and capped at 1000. `getTraceLogs` returns all records for a trace in chronological order.

Retention and batching rules are shared with the telemetry store; see [Stores](../stores.md#retention-and-batching).
See [log integration](../telemetry.md) for LogTape and OpenTelemetry adapters.
