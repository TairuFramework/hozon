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

Sessions belong to `(blobID, owner)`. Each owns a staging ID, manifest, metadata, and present bitmap.
`putSession(input)` atomically replaces only that owner's session with no chunks present.
`getSession(blobID, owner)` and `getSessionByStagingID(stagingID)` return its manifest and progress, or `null`.
`markSessionChunk(blobID, owner, index)` marks an existing chunk present and refreshes `updatedAt`.
`touchSession(blobID, owner)` refreshes activity. Absent sessions and manifest indexes cannot acquire progress.
`listSessions({ owner?, ownerPrefix?, blobID?, limit, cursor? })` pages by `(owner, blob_id)` with opaque cursors.
The limit ranges from 1 to 1000. Printable ASCII owners make prefix bounds exact.
`sumSessionContentLength()` totals all sessions for the staging limit.
`deleteSession(blobID, owner)` ends one session. `deleteSessions(blobID)` ends every session for that blob.
Session endings refresh the release row and cascade session-chunk deletion.
Sessions never change entry state or verified chunk rows.

`deleteEntry` removes the entry, manifest, and every session together.
Entries carry an optional `contentType` (`string | null`).
`listEntries({ limit, cursor })` pages entries by `(createdAt, blobID)` with an opaque cursor. The limit ranges from 1 to 1000.
`promoteEntry(entry, chunks)` replaces the verified layout, marks the entry local, and deletes every session and pending byte deletion.
It preserves existing pin and creation time and refreshes the release row.
`fillContentType(blobID, contentType)` fills a null content type.

Migration `4-fetch-sessions` removes legacy sessions and unverified manifests, changes `partial` entries to `remote-only`, and inserts no release rows.
The down migration recreates the legacy tables empty. The backfill cannot be reversed.
Legacy staging areas become orphans for staging pruning.

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
Manifest inserts batch 166 rows. Session chunk inserts batch 125 rows with four bindings per row.

See the [store reference](../../docs/reference/stores/blob.md).


## Holders and releases

Migration `3-holders` adds entry-independent `blob_refs` and cascading `blob_releases`, without releasing existing entries.
The store exposes `insertRefs`, `deleteRefs`, `deleteRefsByHolder`, `countRefs`, `listRefs`, and keyset-paged `findRefs`.
`upsertReleases`, `listReleases`, and `deleteRelease` maintain the collection work list. `setState` supports `remote`.
Creation, promotion, unpin, ref removal, and session endings refresh releases atomically.
Ref inserts batch at 125 rows, release upserts at 250, and ID lists at 500 bindings.
Ref insertion and entry mutations require `withBlobLocks`. Ref removals only need their own transaction.
Remote transfers preserve verified chunk rows and state until successful promotion.
