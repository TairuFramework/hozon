# Blob store

`@hozon/store-blob` stores metadata, persistent chunk manifests, and resumable transfer progress.
Callers own hashing, byte storage, and digest verification.
Encryption flags and key IDs are optional metadata that the store does not interpret.

Exports include `BLOB_STORE`, `blobStoreDefinition`, `getBlobStore`, `BlobStoreAPI`, `BlobEntry`, `BlobEntryInput`, `BlobChunkInput`, and `BlobState`.
`BlobSession`, `BlobSessionInput`, `ListSessionsParams`, `BLOB_LOCK_TABLE`, and `withBlobLocks` are also exported.
Table types include `BlobTables`, `BlobEntryTable`, `BlobChunkTable`, `BlobFetchSessionTable`, and `BlobFetchChunkTable`.

```ts
type BlobState = 'local' | 'remote' | 'remote-only'
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
type BlobSessionInput = {
  blobID: string; owner: string; stagingID: string; contentLength: number
  chunkSize: number; contentType: string | null; encrypted: boolean; keyID: string | null
  createdAt: number; updatedAt: number; chunks: Array<BlobChunkInput>
}
type BlobSession = Omit<BlobSessionInput, 'chunks'> & {
  chunks: Array<BlobChunkInput & { present: boolean }>; presentChunks: Array<number>
}
type ListSessionsParams = {
  owner?: string; ownerPrefix?: string; blobID?: string; limit: number; cursor?: string
}
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
  getSession(blobID: string, owner: string): Promise<BlobSession | null>
  getSessionByStagingID(stagingID: string): Promise<BlobSession | null>
  listSessions(params: ListSessionsParams): Promise<{
    sessions: Array<BlobSession>; nextCursor: string | null
  }>
  putSession(session: BlobSessionInput): Promise<void>
  markSessionChunk(blobID: string, owner: string, index: number): Promise<void>
  deleteSession(blobID: string, owner: string): Promise<void>
  deleteSessions(blobID: string): Promise<void>
  touchSession(blobID: string, owner: string): Promise<void>
  sumSessionContentLength(): Promise<number>
  listEntries(params: { limit: number; cursor?: string }): Promise<{
    entries: Array<BlobEntry>; nextCursor: string | null
  }>
  promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>
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
| `blob_fetch_sessions` | `blob_id`, `owner`, `staging_id`, `content_length`, `chunk_size`, `content_type`, `encrypted`, `key_id`, `created_at`, `updated_at` | `(blob_id, owner)` |
| `blob_fetch_chunks` | `staging_id`, `index`, `digest`, `present` | `(staging_id, index)` |
| `blob_byte_deletions` | `blob_id`, `queued_at` | `blob_id` |

Physical table names use the configured prefix, which defaults to `hozon`.
`blob_fetch_sessions.blob_id` references `blob_entries` with cascading deletion. Its `staging_id` is unique.
`blob_fetch_chunks.staging_id` references that unique staging ID with cascading deletion.
The `(owner, blob_id)` index supports owner and owner-prefix queries. Owner text uses byte ordering.
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

## Fetch sessions

Each `(blobID, owner)` session owns its staging ID, manifest, metadata, and present bitmap.
Owners contain 1 to 255 printable ASCII characters. The service validates owners before calling the store.
`getSession(blobID, owner)` and `getSessionByStagingID(stagingID)` return the session or `null`.
Session chunks and `presentChunks` are ordered by index.
`putSession(input)` atomically replaces only that owner's session and inserts its manifest with no chunks present.
Entry state and verified `blob_chunks` rows remain unchanged.
`markSessionChunk(blobID, owner, index)` marks an existing manifest index present and touches the session.
It rejects absent sessions or indexes and never creates progress without a manifest.
`touchSession(blobID, owner)` refreshes `updatedAt` and ignores an absent session.
`deleteSession(blobID, owner)` ends one session. `deleteSessions(blobID)` ends every session of that blob.
Both refresh the entry's release row. Session deletion cascades to session chunks.
All session mutations require the blob lock and reuse an enclosing transaction.
Session chunk inserts batch 125 rows, binding four parameters per row.
`sumSessionContentLength()` totals every session's declared content length, returning zero when none exist.

`listSessions({ owner?, ownerPrefix?, blobID?, limit, cursor? })` pages by `(owner, blob_id)`.
Choose either `owner` or `ownerPrefix`. The prefix bound is `owner >= prefix AND owner < prefix || '\x7f'`.
The limit ranges from 1 to 1000. Cursors are opaque, and malformed cursors throw `InvalidCursorError`.

## Listing and promotion

`listEntries({ limit, cursor })` returns entries ordered by `(created_at, blob_id)` ascending.
The limit ranges from 1 to 1000. The last page has a null cursor.
`promoteEntry(entry, chunks)` upserts a local entry while preserving existing pin and creation time.
It replaces the verified chunk layout, deletes every session, clears pending byte deletion, and refreshes the release row atomically.
The new chunk size may differ from the previous layout.
Manifest inserts batch 166 rows, binding three parameters per row.

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
`pruneStaging(olderThan)` skips registered areas, then rechecks transfer sessions under the blob lock before ending that session.
Other processes are protected only by age. The threshold must exceed the longest upload and caller transaction that begins a fetch.

`limits.maxStagingBytes` is optional and unset by default. It counts declared content lengths across all fetch sessions plus writes in flight in this service and its views.
Known write lengths are checked before staging. Unknown lengths are counted while streaming.
Exceeding the limit aborts staging with `StagingLimitError`. Creating or restarting a fetch checks the same limit. Resumes and reads are never refused.
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

Migration `4-fetch-sessions` creates the owner-scoped session and session-chunk tables.
It deletes unverified chunk rows of `partial` entries and changes those entries to `remote-only`.
It drops `blob_transfers`, then `blob_transfer_sessions`, and inserts no release rows.
Legacy staging areas become orphans for `pruneStaging` to reclaim.
The down migration drops the new tables and recreates both legacy tables empty, preserving their keys and foreign keys.
The backfill cannot be reversed.

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

A fetch using the stored chunk size must have identical verified digests, otherwise `InvalidManifestError` precedes session creation.
A different chunk size is accepted and remains in the session until successful promotion replaces the verified layout.
Remote entries retain their state and verified digests during fetching and after session deletion or pruning.
Entry states are `local`, `remote`, and `remote-only`. Fetch progress is available through `listTransfers({ blobID })`.

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
