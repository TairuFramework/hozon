# @hozon/store-blob

Content-addressed blob metadata, persistent chunk manifests, and resumable transfer progress.
Byte storage and digest verification belong to the caller.

```sh
pnpm add @hozon/store-blob @hozon/db
```

```ts
import { blobStoreDefinition, getBlobStore, withBlobLocks } from '@hozon/store-blob'

db.register(blobStoreDefinition)
await withBlobLocks(db, ['content-key'], async (tx) => {
  const blobs = await getBlobStore(tx)
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
})
```

Entries map integer flags to booleans and expose camelCase fields.
Encryption and key IDs are optional metadata that the store does not interpret.
Repeated entry and manifest inserts preserve existing rows.

For an unverified entry, `beginTransfer({ blobID, chunkSize, chunks, stagingID })` records its manifest, sets `partial`, and records a session.
Verified `remote` entries keep their state and layout. The service validates equal chunk size and digests before starting.
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
`resetTransfer(blobID)` atomically drops session and progress. Unverified entries also lose their manifest and become `remote-only`.
Verified remote entries retain their state and manifest. Reset refreshes the release row.
The `1-sessions` migration resets existing `partial` entries to `remote-only`, dropping their manifests; this is not reversible.
Manifest chunks reference entries, and transfer rows reference manifest chunks, with cascading deletion preventing orphan progress.

All entry, transfer, and deletion-journal mutations must run under `withBlobLocks(provider, canonicalBlobIDs, fn)`.
`BLOB_LOCK_TABLE` is `blob_entries`. The helper accepts at most 500 IDs and sorts and deduplicates database lock keys.
It opens a transaction when needed. Inside its callback, obtain stores through the supplied provider.
Locks remain held until transaction commit or rollback, including caller transactions.
Acquire every required blob key together before caller row locks. Separate acquisitions can reverse lock order.

The `2-byte-deletions` migration adds a durable `blob_byte_deletions` journal without changing applied migrations.
`enqueueByteDeletion(blobID, queuedAt?)` upserts bytes for cleanup, replacing the queued timestamp.
`listByteDeletions({ limit? })` lists queued work. `deleteByteDeletion(blobID)` clears completed work.
The journal has no foreign key because metadata can already be gone.
Direct store callers own byte cleanup. `@hozon/blob` provides locked deletion and `drainByteDeletions` replay.

Tables follow the database's configured prefix, which defaults to `hozon`.
Multi-statement mutations are atomic and reuse a provider transaction.
Manifest inserts use batches of 166 rows to stay below 500 bound parameters.

See the [store reference](../../docs/reference/stores/blob.md).


## Holders and releases

Migration `3-holders` adds entry-independent `blob_refs` and cascading `blob_releases`, without releasing existing entries.
The store exposes `insertRefs`, `deleteRefs`, `deleteRefsByHolder`, `countRefs`, `listRefs`, and keyset-paged `findRefs`.
`upsertReleases`, `listReleases`, and `deleteRelease` maintain the collection work list. `setState` supports `remote`.
Creation, promotion, unpin, ref removal, and transfer reset refresh releases atomically.
Ref inserts batch at 125 rows, release upserts at 250, and ID lists at 500 bindings.
Ref insertion and entry mutations require `withBlobLocks`. Ref removals only need their own transaction.
Remote transfers preserve verified chunk rows and state until successful promotion.
