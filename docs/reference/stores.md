# Stores

All stores register through `HozonDB` and use logical table names.
The database's `tablePrefix` applies to store tables, including migration and temporary keep-set tables.
The default prefix is `hozon`, preserving existing physical names `hozon_logs` and `hozon_spans`.
Logs and telemetry keep complete records in a JSON `data` column.
See [table prefix rules](db.md#table-prefixes) for store author requirements.

## Logs

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

`hozon_logs` columns are `seq` (serial primary key), `timestamp` (double), `level`, `category`, nullable `trace_id` and `span_id`, and JSON `data`. Indexes cover timestamp, trace plus timestamp and sequence, and level plus timestamp. Trace and span IDs must be both present or both absent. `addLogs` validates the whole batch before writing.

Category segments are joined with U+001F and a trailing U+001F. For example, `['a', 'b']` encodes as `a\u001fb\u001f`, while `['a.b']` encodes as `a.b\u001f`. Segments containing U+001F are rejected. Prefix queries use a lexicographic range; PostgreSQL's `category` column uses `COLLATE "C"` for correct prefix ordering.

`queryLogs` orders by `(timestamp, seq)`. Its opaque URL-safe base64 cursor encodes that pair and continues strictly after it. Limits are required and capped at 1000. `getTraceLogs` returns all records for a trace in chronological order.

## Telemetry

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

`hozon_spans` stores `seq`, `trace_id`, `span_id`, `start_time`, `end_time`, and JSON `data`. `(trace_id, span_id)` is unique. Indexes cover trace plus start time and sequence, and end time. `addSpans` upserts on the unique trace/span pair. If one call repeats that pair, the last occurrence's data wins.

## Retention and batching

`addLogs([])`, `addSpans([])`, and `deleteByTrace([])` are no-ops. `deleteBefore(t)` and `deleteBefore(t, { keepTraceIDs: [] })` both delete every row older than `t`; this includes untraced logs. A non-empty `keepTraceIDs` protects those traces. IDs are inserted in batches of 500 into a temporary keep set. Trace deletion also chunks IDs, and inserts are batched to keep every statement below 500 bound parameters.

See [log integration](telemetry.md) for LogTape and OpenTelemetry adapters.

## Blobs

`@hozon/store-blob` stores metadata, persistent chunk manifests, and resumable transfer progress.
Callers own hashing, byte storage, and digest verification.
Encryption flags and key IDs are optional metadata that the store does not interpret.

Exports include `BLOB_STORE`, `blobStoreDefinition`, `getBlobStore`, `BlobStoreAPI`, `BlobEntry`, `BlobEntryInput`, `BlobChunkInput`, and `BlobState`.
Table types are `BlobTables`, `BlobEntryTable`, `BlobChunkTable`, and `BlobTransferTable`.

```ts
type BlobState = 'local' | 'partial' | 'remote-only'
type BlobEntryInput = {
  blobID: string; contentLength: number; encrypted?: boolean; keyID?: string | null
  chunkSize: number; state: BlobState; pinned?: boolean; createdAt: number
}
type BlobEntry = {
  blobID: string; contentLength: number; encrypted: boolean; keyID: string | null
  chunkSize: number; state: BlobState; pinned: boolean; createdAt: number
}
type BlobChunkInput = { index: number; digest: Uint8Array }
type BlobStoreAPI = {
  insertEntry(entry: BlobEntryInput, chunks: Array<BlobChunkInput>): Promise<void>
  getEntry(blobID: string): Promise<BlobEntry | null>
  getChunkDigests(blobID: string): Promise<Array<Uint8Array>>
  setPinned(blobID: string, pinned: boolean): Promise<void>
  deleteEntry(blobID: string): Promise<void>
  beginTransfer(blobID: string, chunkSize: number, chunks: Array<BlobChunkInput>): Promise<void>
  recordTransferChunk(blobID: string, index: number): Promise<void>
  getPresentChunkIndexes(blobID: string): Promise<Array<number>>
  finalizeTransfer(blobID: string): Promise<void>
}
const BLOB_STORE: 'blob'
const blobStoreDefinition: StoreDefinition<BlobTables, BlobStoreAPI>
function getBlobStore(provider: StoreProvider): Promise<BlobStoreAPI>
```

### Tables and entry lifecycle

| Logical table | Columns | Primary key |
| --- | --- | --- |
| `blob_entries` | `blob_id`, `content_length`, `encrypted`, `key_id`, `chunk_size`, `state`, `pinned`, `created_at` | `blob_id` |
| `blob_chunks` | `blob_id`, `index`, `digest` | `(blob_id, index)` |
| `blob_transfers` | `blob_id`, `index` | `(blob_id, index)` |

The default physical names are `hozon_blob_entries`, `hozon_blob_chunks`, and `hozon_blob_transfers`.
Content lengths and creation timestamps use bigint columns. `createdAt` is milliseconds since the Unix epoch.
Flags use integer 0/1 columns. `key_id` is nullable text, and `digest` uses the adapter's binary type.
`chunk_size` and `index` are integers. `blob_id` and `state` use text columns.

`insertEntry` preserves an existing entry on `blobID` conflict and inserts missing manifest rows.
Manifest conflicts on `(blob_id, index)` preserve existing digests.
`getEntry` returns camelCase fields and boolean flags, or `null` when absent.
Omitted `encrypted` and `pinned` default to `false`. Omitted `keyID` defaults to `null`.
`getChunkDigests` returns digests in ascending index order.
`setPinned` updates the flag. `deleteEntry` atomically removes entry, manifest, and transfer rows.

### Transfer lifecycle

1. Insert a known remote entry with `state: 'remote-only'`.
2. Call `beginTransfer(blobID, chunkSize, chunks)` to insert manifest rows and set the entry to `partial`.
3. Store and verify each chunk through a backend.
4. Call `recordTransferChunk(blobID, index)` for each verified chunk.
5. Use `getPresentChunkIndexes(blobID)` to resume from the recorded progress.
6. Call `finalizeTransfer(blobID)` after recording every manifest index.

`beginTransfer` preserves existing manifest rows and transfer progress.
Retries must use the existing chunk size once a manifest exists.
Changing it rejects with `Cannot change chunk size for blob <blobID>: manifest already exists`, leaving metadata and progress unchanged.
`recordTransferChunk` is idempotent. Present indexes return in ascending order.
It rejects unknown manifest indexes with `Blob chunk <blobID> at index <index> not found`.
`finalizeTransfer` sets the entry to `local` and purges transfer progress, preserving the manifest.
It rejects missing chunks with `Cannot finalize transfer <blobID>: <count> chunk(s) missing`.
`beginTransfer`, `recordTransferChunk`, and `finalizeTransfer` reject absent entries with `Blob entry <blobID> not found`.
Failed finalisation leaves state and progress unchanged.
Manifest chunks reference entries, and transfer rows reference manifest chunks, with cascading deletion preventing orphan progress.

`insertEntry`, `deleteEntry`, `beginTransfer`, `recordTransferChunk`, and `finalizeTransfer` use `withStoreTransaction` and reuse an enclosing transaction.
Manifest inserts batch 166 rows, binding three parameters per row, below the 500-parameter limit.

## Blob backends

`@hozon/blob-backend` exports `BlobBackend`, `BlobRange`, and `MemoryBlobBackend`.
Backends store bytes without inspecting content. Callers own hashing and content-addressed keys.
The contract uses Web Streams across Node, browser, and mobile runtimes.

```ts
type BlobRange = { start: number; end: number }
type BlobBackend = {
  createStaging(stagingID: string): Promise<WritableStream<Uint8Array>>
  writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void>
  commit(stagingID: string, key: string): Promise<void>
  abortStaging(stagingID: string): Promise<void>
  createReadStream(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  getURL(key: string): Promise<string | null>
}
```

`createStaging` accepts sequential writes. Close the writer before committing.
Reopening it resets existing staging bytes. `writeChunk` preserves other staged ranges for resumable downloads.
`writeChunk` creates staging when absent and writes at an absolute byte offset, supporting out-of-order chunks.
`commit` promotes staging to a key. An existing key remains unchanged, and its redundant staging is discarded.
Concurrent competing uploads preserve the first published bytes. Duplicate commits of the same staging area are idempotent.
`abortStaging` removes abandoned staging. `delete` removes committed bytes and tolerates absent keys.
`BlobRange` uses inclusive start and end offsets.

### MemoryBlobBackend

`new MemoryBlobBackend()` holds staging and committed bytes in memory without persistence.
It copies buffers on write and read, isolating stored bytes from caller mutations.
`getURL` always returns `null`.

### FSBlobBackend

`@hozon/blob-node-fs` exports `FSBlobBackend`. `new FSBlobBackend(root)` requires Node.js 24 or later.
Staging files live at `<root>/staging/<stagingID>`. Committed files live at `<root>/content/<key>`.
Commit atomically publishes a hard link without replacing existing content, then removes staging.
Staging and content must share a filesystem supporting hard links, including NTFS on Windows.
Sequential staging copies chunks before passing them to Node streams.
Positioned writes complete all bytes and reject zero progress.
`getURL` returns a file URL for existing content, or `null` when absent.
`has` returns `false` only for `ENOENT` and propagates other filesystem errors.

Keys and staging IDs must be nonempty and differ from `.`.
They must contain none of `..`, `/`, `\`, `:`, or NUL.
Invalid names reject with `Invalid blob key: <JSON.stringify(value)>`.
