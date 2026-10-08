# @hozon/store-blob

Content-addressed blob metadata, persistent chunk manifests, and resumable transfer progress.
Byte storage and digest verification belong to the caller.

```sh
pnpm add @hozon/store-blob @hozon/db
```

```ts
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'

db.register(blobStoreDefinition)
const blobs = await getBlobStore(db)
await blobs.insertEntry(
  {
    blobID: 'content-key',
    contentLength: 0,
    chunkSize: 4,
    state: 'local',
    createdAt: Date.now(),
  },
  [],
)
```

Entries map integer flags to booleans and expose camelCase fields.
Encryption and key IDs are optional metadata that the store does not interpret.
Repeated entry and manifest inserts preserve existing rows.

For a known remote entry, `beginTransfer({ blobID, chunkSize, chunks, stagingID })` records its manifest, sets its state to `partial`, and records a transfer session for `stagingID`.
Retries with the same chunk size preserve manifest digests. Progress is preserved only while `stagingID` matches the session; a different `stagingID` clears it.
`getTransfer`, `getTransferByStagingID`, and `touchTransfer` read and refresh the session.
Changing chunk size while a manifest exists rejects with `Cannot change chunk size for blob <blobID>: manifest already exists`.
Record each verified chunk with `recordTransferChunk`, then call `finalizeTransfer` when all chunks are present.
Finalisation preserves the manifest, clears transfer progress and the session, and sets the entry state to `local`.
`beginTransfer`, `recordTransferChunk`, and `finalizeTransfer` reject absent entries with `Blob entry <blobID> not found`.
`recordTransferChunk` rejects unknown manifest indexes with `Blob chunk <blobID> at index <index> not found`.
Finalisation rejects missing chunks with `Cannot finalize transfer <blobID>: <count> chunk(s) missing`.
`deleteEntry` removes the entry, manifest, transfer progress, and session together.
Entries carry an optional `contentType` (`string | null`).
`listEntries({ limit, cursor })` pages entries by `(createdAt, blobID)` with an opaque cursor; `limit` is 1 to 1000.
`promoteEntry(entry, chunks)` atomically replaces an entry's manifest and marks it `local`, keeping `pinned` and `createdAt` and clearing transfers and session.
`fillContentType(blobID, contentType)` sets the content type only when the stored one is null.
`resetTransfer(blobID)` atomically drops the session, progress, and manifest and sets the entry to `remote-only`.
The `1-sessions` migration resets existing `partial` entries to `remote-only`, dropping their manifests; this is not reversible.
Manifest chunks reference entries, and transfer rows reference manifest chunks, with cascading deletion preventing orphan progress.

Tables follow the database's configured prefix, which defaults to `hozon`.
Multi-statement mutations are atomic and reuse a provider transaction.
Manifest inserts use batches of 166 rows to stay below 500 bound parameters.

See the [store reference](../../docs/reference/stores/blob.md).
