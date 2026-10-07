# Blob store

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

## Tables and entry lifecycle

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

## Transfer lifecycle

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

Byte storage lives in a backend; see [Blob backends](../blob-backends.md).
