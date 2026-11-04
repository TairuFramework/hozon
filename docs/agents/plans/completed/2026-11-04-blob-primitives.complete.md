# Blob primitives: transaction-scoped locks, refs and GC, remote state, transfer owners

Status: complete (PRs #9, #10, #11, stacked: `feat/blob-locking`, `feat/blob-refs-gc`, `feat/blob-transfer-owners`; released together)

## Goal

Give embedders the generic blob primitives they need to keep blobs safe under concurrency: a lock that lasts until the caller's transaction ends, holders and a collector that deletes a blob only when nothing holds it, an evicted `remote` state, per-owner transfers, and one-shot maintenance. Hozon interprets none of the strings an embedder passes in: holder kinds and keys, and transfer owners, are opaque.

## What was built

- **Locking and per-call providers (#9).**
  - `withBlobLocks` / `BLOB_LOCK_TABLE` in `@hozon/store-blob`, on `withKeyLocks`: Postgres advisory transaction locks, SQLite writer reservation. `BlobLock`, `createMemoryBlobLock`, `BlobLockTimeoutError` and `createFileBlobLock` are removed.
  - `service.using(provider)` views and `withLocks`; `writeWith` is `using(tx).write` plus a callback in one transaction.
  - Two-phase `delete` with the `blob_byte_deletions` journal and `drainByteDeletions`.
  - `40P01` retry for transactions hozon opened (three attempts, jitter); never inside a caller transaction.
  - `TransactionScopeError` in `@hozon/db`: a root-bound transaction opened inside a caller transaction on a single-connection adapter throws instead of hanging, where async context exists (Node, Bun, Deno).
  - Shared in-process staging registry across views; `limits.maxStagingBytes`.
- **Refs, GC, remote and maintenance (#10).**
  - `blob_refs(blob_id, kind, key)` and `blob_releases`; `addRefs` locks every blob in one call and returns the fresh entry; release rows are a work list, not the truth.
  - `collect({ releasedBefore })`: per blob under the lock, phase 1 deletes the row and journals the bytes, phase 2 deletes bytes under the lock only when no `local` row exists.
  - `delete` throws `BlobReferencedError` unless `{ force: true }`.
  - `evict` and the `remote` state (metadata, refs and verified digests kept); pinned blobs throw `BlobPinnedError`; reads throw `BlobNotLocalError`.
  - Optional `BlobBackend.listKeys()` and opt-in `reconcileBytes` with a minimum-age guard; `runMaintenance` runs drain, prune, collect and reconcile, continuing past a failing step.
- **Transfer owners (#11).**
  - Sessions keyed by `(blob, owner)` with their own manifest, staging and progress (`blob_fetch_sessions`, `blob_fetch_chunks`); `partial` removed, migrated to `remote-only`.
  - `abortFetch`, `abortFetches({ owner } | { ownerPrefix })`, `listTransfers`; `completeFetch` returns `{ entry, fetched }`.
  - Re-fetch of a `remote` entry at another chunk size accepted; promotion replaces the layout.
  - Staging stability is part of the `BlobBackend` contract.

## Key design decisions

- **The blob lock is a database key lock.** Every hozon service has a database, so one lock covers every process and host sharing it. It is held until the caller's transaction ends, so nothing can delete bytes before the row's fate is known.
- **Bytes commit last.** Inside the locked transaction every statement runs first and `backend.commit` is the final step. Postgres raises `40P01` only on a statement waiting for a lock, so a deadlock victim keeps its staging for the retry. A savepoint around promote-and-publish means a caught publish failure in a caller transaction cannot leave a `local` row without bytes.
- **Two-phase deletion with a journal.** Deleting bytes before the row commits breaks "local means bytes present" on a crash; deleting after commit without a lock loses a concurrent writer's bytes. Phase 2 under the lock with a fresh `local` re-check closes both, without a generation counter.
- **Refs may precede the entry.** No stub entry is created; the first `write` or `beginFetch` creates it. The migration adds no release rows, so embedders that never used refs keep every existing blob.
- **No per-blob session cap.** Many owners may fetch one blob at once; `limits.maxStagingBytes` bounds staging globally and is advisory across processes.
- **No default grace and no scheduler.** Every maintenance duration is explicit; the embedder decides when to run it.
- **Deadlock rules for callers.** Take blob locks first (`withLocks`), then own row locks; take all keys of one operation in one call; inside `withLocks` use the view it hands you.

## Verification

SQLite suites for `@hozon/db`, `@hozon/store-blob`, `@hozon/blob`, `@hozon/blob-backend` and `@hozon/blob-node-fs` green on each PR. Opt-in Postgres race suites (`HOZON_BLOB_POSTGRES=1`): 7/7, 12/12, 16/16. Each PR had a read-only review with one fix round.

Follow-on: `docs/agents/plans/backlog/2026-11-04-blob-primitives-followups.md`.
