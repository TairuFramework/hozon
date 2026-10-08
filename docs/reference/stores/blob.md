# Blob store

`@hozon/store-blob` stores metadata, persistent chunk manifests, and resumable transfer progress.
Callers own hashing, byte storage, and digest verification.
Encryption flags and key IDs are optional metadata that the store does not interpret.

Exports include `BLOB_STORE`, `blobStoreDefinition`, `getBlobStore`, `BlobStoreAPI`, `BlobEntry`, `BlobEntryInput`, `BlobChunkInput`, and `BlobState`.
`BlobTransfer` is also exported. Table types are `BlobTables`, `BlobEntryTable`, `BlobChunkTable`, `BlobTransferTable`, and `BlobTransferSessionTable`.

```ts
type BlobState = 'local' | 'partial' | 'remote-only'
type BlobEntryInput = {
  blobID: string; contentLength: number; encrypted?: boolean; keyID?: string | null
  chunkSize: number; state: BlobState; pinned?: boolean; createdAt: number
  contentType?: string | null
}
type BlobEntry = {
  blobID: string; contentLength: number; encrypted: boolean; keyID: string | null
  chunkSize: number; state: BlobState; pinned: boolean; createdAt: number
  contentType: string | null
}
type BlobChunkInput = { index: number; digest: Uint8Array }
type BlobTransfer = { stagingID: string; updatedAt: number; presentChunks: Array<number> }
type BlobStoreAPI = {
  insertEntry(entry: BlobEntryInput, chunks: Array<BlobChunkInput>): Promise<void>
  getEntry(blobID: string): Promise<BlobEntry | null>
  getChunkDigests(blobID: string): Promise<Array<Uint8Array>>
  setPinned(blobID: string, pinned: boolean): Promise<void>
  deleteEntry(blobID: string): Promise<void>
  beginTransfer(
    blobID: string, chunkSize: number, chunks: Array<BlobChunkInput>, stagingID: string,
  ): Promise<void>
  recordTransferChunk(blobID: string, index: number): Promise<void>
  getPresentChunkIndexes(blobID: string): Promise<Array<number>>
  finalizeTransfer(blobID: string): Promise<void>
  getTransfer(blobID: string): Promise<BlobTransfer | null>
  getTransferByStagingID(stagingID: string): Promise<{ blobID: string; updatedAt: number } | null>
  touchTransfer(blobID: string): Promise<void>
  listEntries(params: { limit: number; cursor?: string }): Promise<{
    entries: Array<BlobEntry>; nextCursor: string | null
  }>
  promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>
  resetTransfer(blobID: string): Promise<void>
  fillContentType(blobID: string, contentType: string): Promise<void>
}
const BLOB_STORE: 'blob'
const blobStoreDefinition: StoreDefinition<BlobTables, BlobStoreAPI>
function getBlobStore(provider: StoreProvider): Promise<BlobStoreAPI>
```

## Tables and entry lifecycle

| Logical table | Columns | Primary key |
| --- | --- | --- |
| `blob_entries` | `blob_id`, `content_length`, `encrypted`, `key_id`, `chunk_size`, `state`, `pinned`, `created_at`, `content_type` | `blob_id` |
| `blob_chunks` | `blob_id`, `index`, `digest` | `(blob_id, index)` |
| `blob_transfers` | `blob_id`, `index` | `(blob_id, index)` |
| `blob_transfer_sessions` | `blob_id`, `staging_id`, `updated_at` | `blob_id` |

The default physical names are `hozon_blob_entries`, `hozon_blob_chunks`, `hozon_blob_transfers`, and `hozon_blob_transfer_sessions`.
`blob_transfer_sessions.blob_id` references `blob_entries` with cascading deletion, and `staging_id` is unique.
`updated_at` is a bigint in milliseconds since the Unix epoch.
Content lengths and creation timestamps use bigint columns. `createdAt` is milliseconds since the Unix epoch.
Flags use integer 0/1 columns. `key_id` and `content_type` are nullable text, and `digest` uses the adapter's binary type.
`chunk_size` and `index` are integers. `blob_id` and `state` use text columns.

`insertEntry` preserves an existing entry on `blobID` conflict and inserts missing manifest rows.
Manifest conflicts on `(blob_id, index)` preserve existing digests.
`getEntry` returns camelCase fields and boolean flags, or `null` when absent.
Omitted `encrypted` and `pinned` default to `false`. Omitted `keyID` and `contentType` default to `null`.
`getChunkDigests` returns digests in ascending index order.
`setPinned` updates the flag. `deleteEntry` atomically removes entry, manifest, transfer, and session rows.

## Transfer lifecycle

1. Insert a known remote entry with `state: 'remote-only'`.
2. Call `beginTransfer(blobID, chunkSize, chunks, stagingID)` to insert manifest rows, set the entry to `partial`, and record the transfer session for `stagingID`.
3. Store and verify each chunk through a backend.
4. Call `recordTransferChunk(blobID, index)` for each verified chunk.
5. Use `getPresentChunkIndexes(blobID)` to resume from the recorded progress.
6. Call `finalizeTransfer(blobID)` after recording every manifest index.

`beginTransfer` preserves existing manifest rows. It preserves transfer progress only when `stagingID` matches the existing session; a different `stagingID` clears the recorded progress, since the new staging area holds none of those chunks.
Retries must use the existing chunk size once a manifest exists.
Changing it rejects with `Cannot change chunk size for blob <blobID>: manifest already exists`, leaving metadata and progress unchanged.
`recordTransferChunk` is idempotent and refreshes the session's `updated_at`. Present indexes return in ascending order.
It rejects unknown manifest indexes with `Blob chunk <blobID> at index <index> not found`.
`finalizeTransfer` sets the entry to `local` and purges transfer progress and the session, preserving the manifest.
It rejects missing chunks with `Cannot finalize transfer <blobID>: <count> chunk(s) missing`.
`beginTransfer`, `recordTransferChunk`, and `finalizeTransfer` reject absent entries with `Blob entry <blobID> not found`.
Failed finalisation leaves state and progress unchanged.
Manifest chunks reference entries, and transfer rows reference manifest chunks, with cascading deletion preventing orphan progress.

`insertEntry`, `deleteEntry`, `beginTransfer`, `recordTransferChunk`, `finalizeTransfer`, `promoteEntry`, and `resetTransfer` use `withStoreTransaction` and reuse an enclosing transaction.
Manifest inserts batch 166 rows, binding three parameters per row, below the 500-parameter limit.

## Transfer sessions

A session ties an entry's transfer progress to one staging area.
`getTransfer(blobID)` returns `{ stagingID, updatedAt, presentChunks }` (ascending), or `null` without a session.
`getTransferByStagingID(stagingID)` returns `{ blobID, updatedAt }` or `null`.
`touchTransfer(blobID)` sets `updated_at` to now and is a no-op without a session.

## Listing, promotion, and reset

`listEntries({ limit, cursor })` returns entries ordered by `(created_at, blob_id)` ascending.
`limit` must be an integer from 1 to 1000, otherwise it throws.
`nextCursor` is `null` on the last page; otherwise it is an opaque base64url encoding of JSON `[createdAt, blobID]`. A malformed cursor throws `Invalid cursor`.
`promoteEntry(entry, chunks)` runs in one transaction: it upserts the entry with `state: 'local'`, updating every column except `blob_id`, `created_at`, and `pinned`, then deletes existing chunks, transfers, and the session for the ID, and inserts `chunks`.
The chunk size may differ from a previous manifest.
`resetTransfer(blobID)` runs in one transaction: it deletes the session, transfers, and manifest chunks and sets the state to `remote-only`. It is a no-op for unknown IDs.
On Postgres, `beginTransfer`, `promoteEntry`, and `resetTransfer` lock the entry row with `FOR UPDATE`.

## Migrations

The `1-sessions` migration adds `blob_entries.content_type` and the `blob_transfer_sessions` table.
It backfills existing `partial` entries: their manifests and progress are dropped and the state becomes `remote-only`, because pre-session transfers cannot be resumed.
The backfill is not reversible; the down migration drops the column and table only.

Byte storage lives in a backend; see [Blob backends](../blob-backends.md).
