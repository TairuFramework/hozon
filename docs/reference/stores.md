# Stores

Both stores register through `HozonDB` and keep complete records in a JSON `data` column. The migration `tablePrefix` does not change their fixed table names.

## Logs

`@hozon/store-log` exports `LOG_STORE`, `logStoreDefinition`, `getLogStore`, `LogTables`, `LogLevel`, `StoredLog`, `TracedLog`, `QueryLogsParams`, `LogStore`, `isTracedLog`, `encodeCategory`, and `categoryRange`.

`hozon_logs` columns are `seq` (serial primary key), `timestamp` (double), `level`, `category`, nullable `trace_id` and `span_id`, and JSON `data`. Indexes cover timestamp, trace plus timestamp and sequence, and level plus timestamp. Trace and span IDs must be both present or both absent. `addLogs` validates the whole batch before writing.

Category segments are joined with U+001F and a trailing U+001F. For example, `['a', 'b']` encodes as `a\u001fb\u001f`, while `['a.b']` encodes as `a.b\u001f`. Segments containing U+001F are rejected. Prefix queries use a lexicographic range; PostgreSQL's `category` column uses `COLLATE "C"` for correct prefix ordering.

`queryLogs` orders by `(timestamp, seq)`. Its opaque URL-safe base64 cursor encodes that pair and continues strictly after it. Limits are required and capped at 1000. `getTraceLogs` returns all records for a trace in chronological order.

## Telemetry

`@hozon/store-telemetry` exports `TELEMETRY_STORE`, `telemetryStoreDefinition`, `getTelemetryStore`, `TelemetryTables`, `StoredSpan`, and `TelemetryStore`.

`hozon_spans` stores `seq`, `trace_id`, `span_id`, `start_time`, `end_time`, and JSON `data`. `(trace_id, span_id)` is unique. Indexes cover trace plus start time and sequence, and end time. `addSpans` upserts on the unique trace/span pair. If one call repeats that pair, the last occurrence's data wins.

## Retention and batching

`addLogs([])`, `addSpans([])`, and `deleteByTrace([])` are no-ops. `deleteBefore(t)` and `deleteBefore(t, { keepTraceIDs: [] })` both delete every row older than `t`; this includes untraced logs. A non-empty `keepTraceIDs` protects those traces. IDs are inserted in batches of 500 into a temporary keep set. Trace deletion also chunks IDs, and inserts are batched to keep every statement below 500 bound parameters.

See [log integration](telemetry.md) for LogTape and OpenTelemetry adapters.
