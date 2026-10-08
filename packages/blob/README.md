# @hozon/blob

Content-addressed blob service: verified writes over a `BlobBackend` with metadata in `@hozon/store-blob`.
Portable: no Node.js APIs.

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

Options: `codec` (default `blake3Codec`), `chunkSize` (default 1 MiB), `lock` (default `createMemoryBlobLock()`), and `limits` (`maxBlobSize` 1 GiB, `maxChunkSize` 16 MiB, `minChunkSize` 1 KiB).
`createBlobService` throws `Invalid chunkSize` when `chunkSize` is outside the chunk limits, and `Invalid limits` for invalid limits.

## Write

`write(stream, { contentType?, encrypted?, keyID?, expectedID?, maxSize?, signal? })` returns `{ entry, created }`.

1. `expectedID` is canonicalized and decoded before the body is read. A content type embedded in the ID fills an omitted `contentType`; a different one throws `ContentTypeMismatchError`. A decoded length above the limit throws `BlobTooLargeError`.
2. The body streams into a fresh staging area while hashing. Crossing `min(maxSize, limits.maxBlobSize)` throws `BlobTooLargeError`. A stream error aborts staging and rethrows it.
3. A computed ID different from `expectedID` throws `BlobIDMismatchError`.
4. Under the blob lock: an already-local blob keeps its metadata (a null `contentType` is filled from this write) and returns `created: false`. Otherwise bytes are committed, then the entry and manifest are recorded, replacing any `remote-only` or `partial` state and discarding that transfer's staging area.

Bytes are committed before the row, so a failure leaves only orphan bytes, never a row without bytes.
A `contentType` that is not a string of at most 255 characters throws `Error('Invalid contentType')` before the body is read.
Aborting `signal` stops reading, discards staging, and throws `BlobWriteAbortedError`; the signal is checked again before commit.

`writeWith({ stream, ...options, fn })` records the entry and calls `fn(tx, entry)` in one store transaction, returning `{ entry, created, result }`.
It takes the blob lock before the transaction; the caller must not already be inside a store transaction (single-connection SQLite would deadlock).
If `fn` throws, the transaction rolls back and the committed bytes remain as orphans.
While `fn` runs the service holds the blob lock and, on SQLite, the single connection. `fn` must use only `tx`; it must not call blob service methods or use the outer `db`, which would deadlock.

## Read and manage

`get(id)`, `list({ limit, cursor })`, `has(id)` (true only for `local` entries), `getChunkDigests(id)` (returns `[]` for non-`local` entries: unverified peer digests are never re-served), `createReadStream(id, range?)` (local blobs only, inclusive `BlobRange`), `setPinned(id, pinned)`, and `delete(id)`.
Every method canonicalizes `id` first and throws `InvalidBlobIDError` when it is invalid.
`delete` removes the row (manifest and transfer rows cascade), aborts any transfer staging area, then deletes the bytes.

## Peer transfer

- `beginFetch(id, { contentLength, chunkSize, chunks, contentType?, encrypted?, keyID? })` validates the untrusted manifest (`InvalidManifestError`) against the ID and limits, then records the entry as `partial` with a fresh staging ID. A local blob is a no-op; an identical manifest with live staging is idempotent; a different one resets the transfer first. An existing stub whose stored `contentLength` differs from the manifest throws `InvalidManifestError`. A zero-length blob records the service's `chunkSize`, not the peer's.
- `getPresentChunks(id)` lists staged indexes for resume. If the staging area vanished, the transfer is reset and the list is empty.
- `stageChunk({ id, index, bytes })` checks length (`ChunkLengthError`) and digest (`ChunkDigestMismatchError`) before writing.
- `completeFetch(id)` throws `TransferIncompleteError` while chunks are missing. It verifies length and whole-blob digest from the staged bytes before committing; on mismatch it aborts staging, resets the transfer, and throws `BlobIDMismatchError`.

## Staging maintenance

`pruneStaging(olderThan)` returns `{ removed, failed }`. It skips areas modified after `olderThan`.
Only areas with the service's own `w-` (write) and `t-` (transfer) ID prefixes are considered; other names are left untouched. A failure on one area (for example a backend abort error) is counted in `failed` and does not stop the others.
Transfer areas are aborted and reset only if, under the blob lock, the session still points at that staging ID and is itself older than `olderThan`.
Write areas are aborted unless they belong to a write in progress in this process. Writes in other processes are protected only by the age threshold: `olderThan` must exceed the longest upload duration.
A backend without `listStaging` returns `{ removed: 0, failed: 0 }`.
The backend's staging namespace must not be shared with non-service writers that use `w-`/`t-` IDs: such areas would be pruned.
Abandoned `remote-only` stub rows (for example after a reset) are never removed automatically; there is no garbage collection for them.

## Locking

`BlobLock` is `withLock(id, fn)`, keyed by canonical blob ID.
Lock order is always blob lock, then store transaction. Locks are non-reentrant: public methods take the lock once and call unlocked helpers.
`write` (commit and record), `delete`, `setPinned`, `beginFetch`, `stageChunk`, `completeFetch`, transfer resets, and pruning of a transfer area run under the lock.

- `createMemoryBlobLock()` (default): in-process keyed mutex, correct for a single process.
- `createFileBlobLock({ directory, acquireTimeoutMs? })`: from `@hozon/blob-node-fs`: cross-process lock for processes on one host sharing storage, one lock file per ID. `directory` must be on a local filesystem. Exclusion is as strong as `@sozai/lock` provides; its stale-lock reaping has a small documented exclusion gap.
- Multi-host deployments sharing a backend and database need a distributed `BlobLock`. None ships; supply your own. A failed acquire throws `BlobLockTimeoutError`.

## Store registration

The caller must register `blobStoreDefinition` on the `HozonDB` before creating the service. The service does not register it.

## Errors

`BlobNotFoundError`, `BlobTooLargeError`, `BlobIDMismatchError`, `ContentTypeMismatchError`, `ChunkDigestMismatchError`, `ChunkLengthError`, `InvalidManifestError`, `InvalidRangeError`, `BlobWriteAbortedError`, `TransferIncompleteError`, and the re-exported `InvalidBlobIDError` and `BlobLockTimeoutError`.
