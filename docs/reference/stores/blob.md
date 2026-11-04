# Blob store

`@hozon/store-blob` stores metadata, persistent chunk manifests, and resumable transfer progress.
Callers own hashing, byte storage, and digest verification.
Encryption flags and key IDs are optional metadata that the store does not interpret.

Exports include `BLOB_STORE`, `blobStoreDefinition`, `getBlobStore`, `BlobStoreAPI`, `BlobEntry`, `BlobEntryInput`, `BlobChunkInput`, and `BlobState`.
`BlobTransfer`, `BLOB_LOCK_TABLE`, and `withBlobLocks` are also exported. Table types are `BlobTables`, `BlobEntryTable`, `BlobChunkTable`, `BlobTransferTable`, and `BlobTransferSessionTable`.

```ts
type BlobState = 'local' | 'remote' | 'partial' | 'remote-only'
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
type BeginTransferParams = {
  blobID: string; chunkSize: number; chunks: Array<BlobChunkInput>; stagingID: string
}
type BlobTransfer = { stagingID: string; updatedAt: number; presentChunks: Array<number> }
type BlobByteDeletion = { blobID: string; queuedAt: number }
type BlobStoreAPI = {
  enqueueByteDeletion(blobID: string, queuedAt?: number): Promise<void>
  listByteDeletions(params?: { limit?: number }): Promise<Array<BlobByteDeletion>>
  deleteByteDeletion(blobID: string): Promise<void>
  insertEntry(entry: BlobEntryInput, chunks: Array<BlobChunkInput>): Promise<void>
  getEntry(blobID: string): Promise<BlobEntry | null>
  getEntries(
    blobIDs: Array<string>,
    options?: BatchReadOptions,
  ): Promise<Map<string, BlobEntry | null>>
  getChunkDigests(blobID: string): Promise<Array<Uint8Array>>
  setPinned(blobID: string, pinned: boolean): Promise<void>
  deleteEntry(blobID: string): Promise<void>
  beginTransfer(params: BeginTransferParams): Promise<void>
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
const BLOB_LOCK_TABLE: 'blob_entries'
function withBlobLocks<R>(
  provider: StoreProvider,
  blobIDs: Array<string>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R>
```

## Transaction locks and service views

All entry, transfer, and journal mutations require `withBlobLocks` on their canonical blob IDs.
The helper delegates to database key locks on `BLOB_LOCK_TABLE`, accepts at most 500 IDs, and sorts and deduplicates keys.
It opens a transaction for a root provider and reuses an existing provider transaction.
Postgres uses advisory transaction locks across processes and hosts sharing the database. SQLite reserves its writer across processes sharing the file.
Locks remain held until commit or rollback, including caller transaction completion.
Nested calls through the supplied provider pass through for held keys.

```ts
await withBlobLocks(db, [blobID, otherBlobID], async (tx) => {
  const store = await getBlobStore(tx)
  await store.setPinned(blobID, true)
  await store.setPinned(otherBlobID, true)
})
```

WARNING: obtain stores through the callback's provider while holding locks.
Other providers in the same transaction queue behind the callback for those keys.
Acquire all required blob keys together before caller row locks. Separate acquisitions can reverse ordering and deadlock.

`@hozon/blob` exposes the same coordination through `using(provider)` and `withLocks(ids, fn)`.
A view shares the service's backend, codec, limits, and staging registry.

```ts
await db.withTransaction(async (tx) => {
  await blobs.using(tx).withLocks([blobID, otherBlobID], async (locked, provider) => {
    await locked.setPinned(blobID, true)
    await locked.setPinned(otherBlobID, true)
    const store = await getBlobStore(provider)
    await store.fillContentType(blobID, 'application/octet-stream')
  })
})
```

WARNING: use the supplied `locked` view inside `withLocks`, including nested operations.
Operations on outer views can queue behind their own callback and hang.
Use `using(tx)` for every service call inside a caller transaction, including reads.
On single-connection SQLite, root transaction entry throws `TransactionScopeError` when async context identifies the active caller.
Unrelated calls still queue. Plain root reads are not intercepted and can hang.
Expo and browser runtimes without async context cannot detect this misuse. They require the same transaction-bound view rule.
Hozon retries transactions it opens on Postgres `40P01`, with jitter, at most three attempts total.
Caller transactions own their retry and receive the error unchanged.
Deadlocks in publication statements leave staging intact because those statements precede byte publication.
`writeWith` retains prepared staging and hashes between owned transaction attempts, without rereading the input stream.
Its callback can execute later statements after byte publication. Such failures can consume staging before retry.
A retry finding neither staging nor committed bytes rethrows the original transaction error.
Database commit failures can still leave orphan bytes.

## Tables and entry lifecycle

| Logical table | Columns | Primary key |
| --- | --- | --- |
| `blob_entries` | `blob_id`, `content_length`, `encrypted`, `key_id`, `chunk_size`, `state`, `pinned`, `created_at`, `content_type` | `blob_id` |
| `blob_chunks` | `blob_id`, `index`, `digest` | `(blob_id, index)` |
| `blob_transfers` | `blob_id`, `index` | `(blob_id, index)` |
| `blob_transfer_sessions` | `blob_id`, `staging_id`, `updated_at` | `blob_id` |
| `blob_byte_deletions` | `blob_id`, `queued_at` | `blob_id` |

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
`getEntry` batches concurrent calls into one query. Inside a scope or transaction it remembers results until a mutation of that blob through the same scoped store; writes through other providers can leave them stale (see "Batch loading and scopes" in [db.md](../db.md)).
`getEntries` dedupes the IDs and runs one query. It returns every requested ID, with `null` for absent entries, and an empty `Map` for empty input without querying.
It always reads fresh rows, ignoring batched and remembered `getEntry` values.
It throws `BatchLimitError` above 500 unique IDs or above `options.batchLimit`.
`getChunkDigests` returns digests in ascending index order.
`setPinned` updates the flag. `deleteEntry` atomically removes entry, manifest, transfer, and session rows.

## Transfer lifecycle

1. Insert a known remote entry with `state: 'remote-only'`.
2. Call `beginTransfer({ blobID, chunkSize, chunks, stagingID })` to insert manifest rows, set the entry to `partial`, and record the transfer session for `stagingID`.
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
`resetTransfer(blobID)` deletes session and progress atomically. Unverified entries also lose manifest chunks and become `remote-only`.
Verified remote entries retain state and chunks. Reset refreshes release eligibility. Unknown IDs are a no-op.
On Postgres, `beginTransfer`, `promoteEntry`, and `resetTransfer` lock the entry row with `FOR UPDATE`.

## Publication and deletion

The service stages and hashes writes before acquiring the database lock.
Under the lock, all metadata and manifest statements run before `backend.commit` publishes bytes.
For standalone publication, byte commit is the last operation before the database transaction commits.
`completeFetch` uses the same statement-before-publication ordering.
The lock prevents byte deletion until the publishing transaction's outcome is known.
After rollback, reclaim acquires a fresh transaction and lock. It deletes bytes only when no local row exists.
A queued writer can therefore publish safely before reclaim runs. A process crash can still leave orphan bytes.
`writeWith({ stream, ...options, fn })` opens a provider transaction, calls `using(tx).write`, and invokes `fn(tx, entry)` before commit.
Its lock lasts through the callback. A callback failure rolls back metadata and schedules reclaim.
Inside a caller transaction, call `using(tx).write` directly.
Post-settlement cleanup opens fresh transactions through `db.root ?? db`.
Built-in providers retain a lifetime-independent root across transaction, savepoint, and lock-scoped providers.
Custom transaction providers must supply `root` for this cleanup.
The optional logger uses `error(message, properties)`. Its default calls `console.error` without a logging dependency.
Logging failures never reject cleanup hooks.

`enqueueByteDeletion(blobID, queuedAt = Date.now())` upserts a journal row, replacing an existing timestamp.
`listByteDeletions({ limit = 100 })` orders by `(queued_at, blob_id)`. The limit is an integer from 1 to 500.
`deleteByteDeletion(blobID)` clears a journal row. Both journal mutations require the blob lock.
The journal has no foreign key because deletion can remove metadata first.

Service `delete(id, { force? })` refuses referenced blobs with `BlobReferencedError` unless forced.
Force removes refs in the same transaction. Pins do not block explicit deletion.
Deletion removes metadata and enqueues local bytes in one locked transaction.
After commit, a fresh locked transaction deletes bytes only when no local entry exists, then clears the journal.
Publication clears its pending deletion row and keeps its bytes.
Root-bound deletion runs byte cleanup inline. Cleanup failures propagate and leave replayable journal work.
Transaction-bound deletion registers cleanup through `tx.onCommit`. Failures are logged and leave replayable journal work.
Transfer staging cleanup also runs after commit.
`drainByteDeletions({ limit? })` replays pending work and reports `{ deleted, failed }`. Embedders run it at startup or as needed.

## Staging and byte I/O

All service views share one in-process staging registry.
It tracks writes in flight and transfer staging created inside unfinished caller transactions.
`pruneStaging(olderThan)` skips registered areas, then rechecks transfer sessions under the blob lock before reset.
Other processes are protected only by age. The threshold must exceed the longest upload and caller transaction that begins a fetch.

`limits.maxStagingBytes` is optional and unset by default. It counts writes in flight in this service and its views.
Known write lengths are checked before staging. Unknown lengths are counted while streaming.
Exceeding the limit aborts staging with `StagingLimitError`. Fetch sessions and reads are excluded from this limit.
Other processes' writes are not counted.

For root-bound calls, `stageChunk` byte writes and `completeFetch` whole-blob hashing run outside the lock.
The locked portion rechecks the staging session before updating or committing.
Transaction-bound views lock the whole operation, including long byte I/O, preserving SQLite snapshot ordering.

## Migrations

The `2-byte-deletions` migration adds `blob_byte_deletions(blob_id, queued_at)` with an index on `(queued_at)`.
`blob_id` is its primary key. `queued_at` is bigint milliseconds since the Unix epoch.
The down migration drops this table. Applied `0-init` and `1-sessions` migrations remain unchanged.

The `1-sessions` migration adds `blob_entries.content_type` and the `blob_transfer_sessions` table.
It backfills existing `partial` entries: their manifests and progress are dropped and the state becomes `remote-only`, because pre-session transfers cannot be resumed.
The backfill is not reversible; the down migration drops the column and table only.

Byte storage lives in a backend; see [Blob backends](../blob-backends.md).


## Holders and collection

A ref `(blobID, kind, key)` keeps a blob. Refs may precede an entry without creating one.
Kinds match `^[a-z][a-z0-9_-]{0,63}$`. Keys contain 1 to 512 printable ASCII characters (`0x20` to `0x7e`).
Holder strings are opaque. Hash longer or non-ASCII natural keys before using them.

`addRefs(refs)` accepts at most 500 refs, canonicalises IDs, and locks all distinct blobs together.
It inserts idempotently and returns a map of fresh entries or `null` per canonical ID.
`removeRefs(refs)` and `removeHolders({ kind, key } | { kind, keyPrefix })` return the number removed.
Removal and release updates share a transaction, including when called through `using(tx)`.
Removal needs no blob lock because collection rechecks holders under its lock.
`listRefs(id)` returns refs. `findRefs({ kind, key?, keyPrefix?, blobID?, limit, cursor? })` pages by `(kind, key, blob_id)`.
Choose either `key` or `keyPrefix`. The prefix bound is exact: `key >= prefix AND key < prefix || '\x7f'`.
Limits for ref pages range from 1 to 1000. Cursors are opaque.

`collect({ releasedBefore, limit? })` drains pending byte deletions, then considers release rows oldest first.
Its default limit is 100, with a maximum of 500. The cutoff is strict: `released_at < releasedBefore`.
Every candidate gets its own locked transaction. Collection locks its release row before checking entry, refs, pin, and session.
This serialises release upserts from concurrent lock-free ref removals, preventing fresh work from being discarded.
Refs, pins, and active fetch sessions keep entries and clear their stale release rows.
Unheld entries are removed. Local bytes use the durable two-transaction deletion protocol.
The result contains `{ deleted, kept, failed }`. A byte-cleanup failure counts as failed and leaves journal work for replay.

Release rows refresh when refs are removed, pins clear, entries are created or promoted, fetch sessions end, or entries are evicted.
They are a work list, not proof that a blob is unheld. Every caller supplies its grace cutoff.
Migration `3-holders` adds `blob_refs` and `blob_releases`, with holder and release-time indexes.
Ref rows have no entry foreign key. Release rows cascade with entry deletion.
The migration creates no release rows for existing entries, so collection preserves them until a later release event.
Ref inserts use 125 rows per statement, release upserts use 250, and ID lists use at most 500 bindings.

## Remote entries and eviction

`evict(id)` returns false for absent or non-local entries and throws `BlobPinnedError` for pinned local entries.
It keeps metadata, refs, and verified chunk digests, changes the state to `remote`, and journals byte deletion.
Caller-bound eviction defers byte deletion until commit. Rollback preserves the local entry and bytes.
`has` returns false for remote entries. `getChunkDigests` returns an empty array for every non-local entry.
`createReadStream` throws `BlobNotLocalError`, a `BlobNotFoundError` subclass exposing `state`, for known non-local entries.
Writing the same content re-populates a remote entry, preserving its pin and creation time.

A fetch of a remote entry must use its stored chunk size and identical verified digests.
Other digests or a different chunk size throw `InvalidManifestError` before creating a session.
Remote entries retain their state and verified digests during fetching and after session reset or pruning.
Other in-progress entries continue using `partial` with today's single-session API.

## Maintenance and reconciliation

`reconcileBytes({ olderThan, limit? })` enumerates optional backend `listKeys` output.
It considers valid codec keys older than the cutoff, then locks each blob and deletes bytes unless a local entry exists.
The default limit is 100 byte-deletion attempts. It must be a positive integer. Retained local keys do not consume the limit.
`scanned` includes eligible local keys, so it can exceed the limit. Invalid keys and newer keys are excluded.
It returns `{ scanned, deleted, failed }`. Missing `listKeys` throws `BlobReconcileUnsupportedError`.
The age must exceed the longest caller transaction that writes, protecting publication before metadata settlement.

`runMaintenance({ grace, stagingOlderThan, bytesOlderThan?, limit? })` takes durations in milliseconds.
It runs drain, prune, collect, then optional reconciliation, using one captured current time for cutoffs.
The result contains `drained`, `pruned`, `collected`, and `reconciled`, which is null when reconciliation was omitted.
A throwing step is logged and represented by a result with `failed: 1`. Later steps still run.
Collection also performs its own initial drain. Scheduling belongs to the embedder.
