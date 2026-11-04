# @hozon/blob

Content-addressed blob service: verified writes over a `BlobBackend` with metadata in `@hozon/store-blob`.
Portable byte operations use Web Streams.

```sh
pnpm add @hozon/blob @hozon/blob-backend @hozon/store-blob @hozon/db
```

```ts
import { MemoryBlobBackend } from '@hozon/blob-backend'
import { createBlobService } from '@hozon/blob'
import { blobStoreDefinition } from '@hozon/store-blob'

// Registering the store definition is the caller's job.
db.register(blobStoreDefinition)
const blobs = createBlobService({ db, backend: new MemoryBlobBackend() })

const { entry, created } = await blobs.write({ stream, contentType: 'image/png' })
```

Options: `codec` (default `blake3Codec`), `chunkSize` (default 1 MiB), `limits` (`maxBlobSize` 1 GiB, `maxChunkSize` 16 MiB, `minChunkSize` 1 KiB), `runtime`, and `logger`.
`logger` accepts an `error(message, properties)` method. Without it, cleanup failures use `console.error`.
Logging failures do not reject cleanup hooks. No logging package is required.
`limits.maxStagingBytes` is unset by default. It limits writes in flight across this service and its views, excluding fetch sessions and reads.
Known lengths are checked before staging. Unknown lengths are counted while streaming. Exceeding the limit aborts staging with `StagingLimitError`.
`createBlobService` throws `Invalid chunkSize` when `chunkSize` is outside the chunk limits, and `Invalid limits` for invalid limits.

## Write

`write({ stream, contentType?, encrypted?, keyID?, expectedID?, maxSize?, signal? })` returns `{ entry, created }`.

1. `expectedID` is canonicalized and decoded before the body is read. A content type embedded in the ID fills an omitted `contentType`; a different one throws `ContentTypeMismatchError`. A decoded length above the limit throws `BlobTooLargeError`.
2. The body streams into a fresh staging area while hashing. Crossing `min(maxSize, limits.maxBlobSize)` throws `BlobTooLargeError`. A stream error aborts staging and rethrows it.
3. A computed ID different from `expectedID` throws `BlobIDMismatchError`.
4. Under the blob lock, a local blob keeps its metadata, fills a null content type, and returns `created: false`.
   Otherwise all metadata and manifest statements run first, replacing `remote`, `remote-only`, or `partial` state and clearing pending deletion work.
   `backend.commit` publishes the bytes last, before the database transaction commits. Replaced transfer staging is discarded after commit.

Metadata statements run before byte publication, while metadata remains uncommitted.
Bytes are published before the database transaction commits. The lock prevents deletion until commit or rollback.
After rollback, asynchronous reclaim reacquires the lock and deletes bytes only when no local row exists.
Savepoint rollback defers reclaim until the parent transaction ends.
A process crash can still leave orphan bytes.
A `contentType` that is not a string of at most 255 characters throws `Error('Invalid contentType')` before the body is read.
Aborting `signal` stops reading, discards staging, and throws `BlobWriteAbortedError`; the signal is checked again before commit.

`writeWith({ stream, ...options, fn })` records the entry and calls `fn(tx, entry)` in one store transaction, returning `{ entry, created, result }`.
It opens a transaction on the configured provider and calls `using(tx).write` before `fn`.
The blob lock remains held through `fn` until commit or rollback. A thrown callback rolls back metadata and schedules byte reclaim.
Inside `fn`, obtain stores through `tx`.
For workflows involving several blob keys, open a caller transaction and acquire every key together with `using(tx).withLocks` before writing.
Inside an existing caller transaction, use `blobs.using(tx).write` directly.

## Read and manage

`get(id)`, `list({ limit, cursor })`, `has(id)` (true only for `local` entries), `getChunkDigests(id)` (returns `[]` for non-`local` entries: unverified peer digests are never re-served), `createReadStream(id, range?)` (local blobs only, inclusive `BlobRange`), `setPinned(id, pinned)`, and `delete(id)`.
Every method canonicalizes `id` first and throws `InvalidBlobIDError` when it is invalid.
`delete(id)` returns `false` for an absent entry and `true` when metadata was removed.
Under the database lock, it deletes metadata and queues local bytes in the durable `blob_byte_deletions` journal.
After commit, a fresh locked transaction deletes bytes only if no local entry exists, then clears the journal.
A new publication clears its journal row and keeps its bytes.
For root calls, byte deletion runs inline and failures propagate, leaving the journal for replay.
For transaction-bound views, byte deletion runs through `tx.onCommit`. Failures are logged and remain replayable.
Transfer staging cleanup also runs after commit.
`drainByteDeletions({ limit? })` retries queued deletions and returns `{ deleted, failed }`. Run it on startup and as needed.

## Peer transfer

- `beginFetch(id, { contentLength, chunkSize, chunks, contentType?, encrypted?, keyID? })` validates the untrusted manifest (`InvalidManifestError`) against the ID and limits, then records a fresh session. Unverified entries become `partial`; verified remote entries remain `remote`. A local blob is a no-op; an identical manifest with live staging is idempotent; a different one resets the transfer first. An existing stub whose stored `contentLength` differs from the manifest throws `InvalidManifestError`. An unverified zero-length blob records the service's `chunkSize`. Remote blobs require their stored size, including empty blobs.
- `getPresentChunks(id)` lists staged indexes for resume. If the staging area vanished, the transfer is reset and the list is empty.
- `stageChunk({ id, index, bytes })` checks length (`ChunkLengthError`) and digest (`ChunkDigestMismatchError`) before writing.
- `completeFetch(id)` throws `TransferIncompleteError` while chunks are missing. It verifies length and whole-blob digest from the staged bytes before committing; on mismatch it aborts staging, resets the transfer, and throws `BlobIDMismatchError`.

## Staging maintenance

`pruneStaging(olderThan)` returns `{ removed, failed }`. It skips areas modified after `olderThan`.
Only areas with the service's own `w-` (write) and `t-` (transfer) ID prefixes are considered; other names are left untouched. A failure on one area (for example a backend abort error) is counted in `failed` and does not stop the others.
Transfer areas are aborted and reset only if, under the blob lock, the session still points at that staging ID and is itself older than `olderThan`.
Every `using` view shares the service's staging registry.
Pruning skips writes in progress and transfer staging created inside an unfinished caller transaction.
Other processes are protected only by age. The age threshold must exceed the longest upload and caller transaction that begins a fetch.
A backend without `listStaging` returns `{ removed: 0, failed: 0 }`.
The backend's staging namespace must not be shared with non-service writers that use `w-`/`t-` IDs: such areas would be pruned.
Abandoned `remote-only` entries become eligible for explicit `collect` after their session ends and their release passes grace.
No scheduler runs automatically.

## Locking

Every mutation uses database key locks through `withBlobLocks`. There is no configurable backend lock.
Postgres advisory locks coordinate processes and hosts using the same database. SQLite reserves the database writer.
Locks last until transaction commit or rollback, including caller-owned transactions.
Root operations acquire a connection before taking database locks.

Cleanup uses `db.root ?? db` to open fresh transactions after settlement.
Built-in providers expose the lifetime-independent root even when the service's default provider is transaction-bound.
Custom transaction providers must supply `root` when post-settlement cleanup needs a new transaction.

`using(provider)` returns a cheap `BlobOperations` view bound to that provider, sharing backend, codec, limits, and staging registry.

```ts
await db.withTransaction(async (tx) => {
  const view = blobs.using(tx)
  await view.withLocks([blobID, otherBlobID], async (locked, provider) => {
    await locked.setPinned(blobID, true)
    await locked.setPinned(otherBlobID, true)
    const records = await provider.getStore('records')
    await records.link(blobID)
  })
})
```

WARNING: use only the callback's `locked` view and supplied provider inside `withLocks`.
Calling outer service or transaction views for held keys queues behind the callback and can hang.
Nested calls through the supplied view pass through for keys already held.
Acquire all required keys together, before caller row locks. Keys are sorted and deduplicated, with at most 500 IDs per acquisition.
Separate acquisitions can reverse lock order and cause database or transaction-local queue deadlocks.
Hozon retries its own transactions on Postgres `40P01`, with jitter, at most three attempts total.
Caller transactions are never retried automatically.
Callbacks can run again. Create fresh input streams inside a retried `withLocks` callback.
Publication statements precede byte commit, so deadlocks in those statements leave staging intact for retry.
`writeWith` retains prepared staging and hashes across its own transaction attempts without reading the input stream again.
Its callback can execute later statements after byte publication, so a callback failure can consume staging before retry.
If retry finds neither staging nor committed bytes, it preserves the original transaction error.
Database commit failures can still leave orphan bytes.

WARNING: use `using(tx)` inside caller transactions, including for reads.
Root transaction entry on single-connection SQLite throws `TransactionScopeError` when async context detects the active caller.
Unrelated concurrent calls still queue. Plain root reads are not intercepted and can still hang.
Expo and browser runtimes without async context cannot detect misuse. They require the same transaction-bound view rule.

Root `stageChunk` writes and `completeFetch` hashing run outside the lock, then recheck the staging session under it.
Transaction-bound views hold the lock for the whole operation, including long byte I/O, to preserve SQLite snapshot ordering.

## Store registration

The caller must register `blobStoreDefinition` on the `HozonDB` before creating the service. The service does not register it.

## Errors

`BlobNotFoundError`, `BlobTooLargeError`, `BlobIDMismatchError`, `ContentTypeMismatchError`, `ChunkDigestMismatchError`, `ChunkLengthError`, `InvalidManifestError`, `InvalidRangeError`, `BlobWriteAbortedError`, `TransferIncompleteError`, `StagingLimitError`, and the re-exported `InvalidBlobIDError`.
`TransactionScopeError` is exported by `@hozon/db`.


## Holders, eviction and maintenance

`addRefs([{ blobID, kind: 'doc', key: 'owner-a' }])` keeps blobs and returns their fresh entries, including null for missing entries.
Use `removeRefs`, `removeHolders`, `listRefs`, and `findRefs` to manage opaque holders.
Kinds match `^[a-z][a-z0-9_-]{0,63}$`. Keys contain 1 to 512 printable ASCII characters.
`collect({ releasedBefore, limit? })` removes released blobs only when refs, pins, and fetch sessions are absent.
Every caller chooses its grace cutoff. Existing entries receive no release row during migration.
`delete(id)` throws `BlobReferencedError` when held. `delete(id, { force: true })` removes refs atomically.

`evict(id)` retains metadata, refs, and verified digests while dropping bytes and setting state `remote`.
Pinned local blobs throw `BlobPinnedError`. Non-local reads throw `BlobNotLocalError`, exposing `state`.
Writing re-populates a remote entry. Fetching requires its stored chunk size and equal verified digests.
Other digests or chunk sizes throw `InvalidManifestError` before session creation. Reset preserves the remote layout.

`reconcileBytes({ olderThan, limit? })` removes orphan committed keys when the backend supports optional `listKeys`.
The age must exceed the longest caller transaction that writes. Unsupported backends throw `BlobReconcileUnsupportedError`.
`runMaintenance({ grace, stagingOlderThan, bytesOlderThan?, limit? })` runs drain, prune, collect, then optional reconciliation.
Durations are explicit milliseconds. Every step reports counts. Logged step failures allow later steps to run.
