# Stores

All stores register through `HozonDB` and use logical table names.
The database's `tablePrefix` applies to store tables, including migration and temporary keep-set tables.
The default prefix is `hozon`, preserving existing physical names `hozon_logs` and `hozon_spans`.
See [table prefix rules](db.md#table-prefixes) for store author requirements.

| Store | Package | Name | Logical tables | Reference |
| --- | --- | --- | --- | --- |
| Logs | `@hozon/store-log` | `log` | `logs`, `keep_log` | [Log store](stores/log.md) |
| Telemetry | `@hozon/store-telemetry` | `telemetry` | `spans`, `keep_telemetry` | [Telemetry store](stores/telemetry.md) |
| Blobs | `@hozon/store-blob` | `blob` | `blob_entries`, `blob_chunks`, `blob_transfers` | [Blob store](stores/blob.md) |

Blob bytes are stored outside the database by a `BlobBackend`; see [Blob backends](blob-backends.md).

## Retention and batching

`addLogs([])`, `addSpans([])`, and `deleteByTrace([])` are no-ops. `deleteBefore(t)` and `deleteBefore(t, { keepTraceIDs: [] })` both delete every row older than `t`; this includes untraced logs. A non-empty `keepTraceIDs` protects those traces. IDs are inserted in batches of 500 into a temporary keep set. Trace deletion also chunks IDs, and inserts are batched to keep every statement below 500 bound parameters.

See [log integration](telemetry.md) for LogTape and OpenTelemetry adapters.
