# Blob primitives: transaction-scoped locks, refs and GC, remote state, transfer owners

Date: 2026-11-03. Status: draft for review; open questions resolved 2026-11-03 (see "Resolved decisions").
Packages: `@hozon/db`, `@hozon/store-blob`, `@hozon/blob`, `@hozon/blob-backend`, `@hozon/blob-node-fs`, `@teikyo/blob`.
Base: hozon `main` at `bde10ed` (blob 0.3.0, blob-backend 0.2.0, blob-node-fs 0.2.0, store-blob 0.4.0, db 0.5.0); teikyo blob 0.3.1.

## Goal

Give hozon the generic blob primitives an embedder needs to keep blobs safely under concurrency:

1. A lock that is held until the caller's transaction ends. Service calls that run in the caller's transaction.
2. Structured holders (refs) and a garbage collector that deletes a blob only when nothing holds it.
3. A `remote` entry state and `evict`: metadata kept, bytes dropped, re-fetch later.
4. Transfer owners: a fetch resumes only for the owner that started it.
5. One-shot maintenance: drain, prune, collect and reconcile in one call.
6. A teikyo hook that decides the served `Content-Type` per request.

Hozon interprets none of the strings an embedder passes in. Holder kinds and keys, and transfer owners, are opaque. An embedder maps its own concepts onto them.

## Non-goals

- Access, capability or any embedder-level concept in hozon.
- A scheduler. Hozon exposes `runMaintenance` and its parts; the embedder decides when to run them. Teikyo offers an optional interval, off by default.
- Two hozon databases sharing one backend root. Bytes belong to one database.
- Revocation, authentication or authorisation changes in teikyo, beyond deciding who may force a delete.
- Encryption at rest, quotas, or eviction policy (LRU and so on). `evict` is a mechanism only. `limits.maxStagingBytes` bounds staging, not stored bytes.
- Changes to `@hozon/blob-id` (blob ID format work is hozon PR #8, separate).

## Background

All paths are relative to `packages/` in the hozon worktree unless prefixed `teikyo:`.

### Service binding and locking

- `createBlobService` binds one `db: StoreProvider` for the life of the service (`blob/src/service.ts:24-33`, `:64-73`). A call inside a caller transaction needs a second service per call.
- The default lock is an in-memory keyed promise chain created per service (`blob/src/service.ts:69`, `blob-backend/src/lock.ts:16-36`). It is non-reentrant (`blob-backend/src/lock.ts:1-5`). A file lock exists for cross-process use on one host (`blob-node-fs/src/lock.ts:14-37`). No distributed lock ships.
- `withLock` returns when its callback returns. Inside a caller transaction that is before the commit.
- `writeBlob` stages and hashes outside the lock, then under it commits bytes (`blob/src/write.ts:201`) and only then records the entry (`:223`). `record` opens `ctx.db.withTransaction` (`:85-89`). On a transaction-bound provider that runs inline (`db/src/db.ts:97-101`), so the lock is released while the row is still uncommitted.
- `activeWrites` is per service (`blob/src/write.ts:39-41`, `blob/src/service.ts:72`). `pruneStaging` only skips write staging IDs in that set (`blob/src/prune.ts:31`). A per-call service hides its writes from the long-lived service's prune; only the age threshold protects them.
- `delete` removes the row, then the bytes, both under the in-memory lock and outside any transaction (`blob/src/manage.ts:29-47`). A writer in another process, or under another lock instance, can commit between the two and lose its bytes.
- Store writes take Postgres `FOR UPDATE` on `blob_entries` in `beginTransfer`, `promoteEntry` and `resetTransfer` (`store-blob/src/api.ts:169`, `:357`, `:391`). `insertEntry` is `ON CONFLICT DO NOTHING` with no lock (`:126`). `setPinned` takes none (`:143-151`).
- `@hozon/db` already has transaction-scoped key locks: `withKeyLocks(provider, table, keys, fn)` (`db/src/sync.ts:95-180`). On Postgres it takes `pg_advisory_xact_lock` per key, sorted (`:169`), held until the transaction ends. On SQLite it reserves the writer with a zero-row `DELETE` before the callback (`:151-155`); the reservation lasts until commit. An in-process queue serialises callbacks of one transaction root (`:166`). Contract: `docs/reference/db.md` "Sync primitives".
- `withKeyLocks` is covered by the conformance sync cases (`conformance/src/cases/sync.ts`), which run on node-sqlite, the Postgres integration run, e2e-expo, e2e-web (sqlocal) and e2e-electron. Every adapter the lock design rests on is exercised.

### Entries and transfers

- `BlobState = 'local' | 'partial' | 'remote-only'` (`store-blob/src/types.ts:3`).
- One transfer session per blob: `blob_transfer_sessions` has primary key `blob_id` (`store-blob/src/migrations.ts:60-64`). The manifest lives in `blob_chunks`, the present bitmap in `blob_transfers` (`:19-45`).
- `beginFetch` resumes an identical manifest for any caller (`blob/src/transfer.ts:203-211`). There is no owner. A second caller inherits the first caller's staged chunks.
- There is no abort. A transfer ends through `delete`, `pruneStaging`, a vanished staging area (`blob/src/transfer.ts:252-254`) or a digest mismatch (`:338-346`).
- `completeFetch` hashes the staging area under the lock (`blob/src/transfer.ts:337`), commits bytes (`:350`) and then promotes the row (`:351`).
- Non-local reads throw `BlobNotFoundError` (`blob/src/read.ts:49`). `getChunkDigests` returns `[]` for non-local entries (`:37`).

### Refs and GC

- None. Hozon has no notion of a holder. `delete` is the only way bytes go.

### Backend

- `BlobBackend` (`blob-backend/src/backend.ts`) has optional `listStaging` but no way to enumerate committed keys. Bytes left without a row by a crash cannot be found.
- The contract does not say whether a staging area may change once fully written.

### Teikyo

- `teikyo:handlers/read.ts:68` serves `entry.contentType || 'application/octet-stream'`. There is no hook. `/meta` returns the stored type and state (`:95-110`).
- `teikyo:plugin.ts:45-48` picks `lock` from `BlobServiceParams` and passes it through (`:150`). Start-up runs `pruneStaging` once (`:155`).
- Teikyo has no admin or role concept. Authorisation is the embedder's `BlobAuthorizer`, called per `BlobAction` (`'read' | 'write' | 'delete' | 'pin' | 'list'`, `teikyo:blob/src/types.ts:5`). Grants and capabilities name the action (`teikyo:blob/src/resources.ts`).

## Design

### Invariants

- I1. After commit, an entry in state `local` has its bytes in the backend.
- I2. Bytes are deleted only under the blob lock, and only when no committed or lock-holding transaction has a `local` row for them.
- I3. Every mutation of a blob's entry, sessions, refs-with-effect or deletion journal runs under that blob's lock.
- I4. Hozon never holds an in-process lock while waiting for a database connection.

I1 holds for bytes deleted by hozon. Bytes may exist without a row (orphans); that wastes space but is not incorrect, since content-addressed bytes are always right for their key. `reconcileBytes` (section 5) removes them.

### 1. Transaction-scoped locking and per-call providers

#### The lock

The blob lock becomes a database key lock. It replaces `BlobLock` in the service.

```ts
// @hozon/store-blob
export const BLOB_LOCK_TABLE = 'blob_entries'

// Locks canonical blob IDs until the provider's transaction ends. Opens a transaction when
// `provider` is not transaction-bound. `fn` must use the provider it receives.
export function withBlobLocks<R>(
  provider: StoreProvider,
  blobIDs: Array<string>,
  fn: (tx: StoreProvider) => Promise<R>,
): Promise<R>
```

It calls `withKeyLocks(provider, BLOB_LOCK_TABLE, blobIDs.map((id) => [id]), fn)`. At most 500 IDs per call (`assertBatchSize`).

- Postgres: advisory transaction locks. Held until commit or rollback. Cross-process and cross-host for one database.
- SQLite: the zero-row `DELETE` reserves the writer until commit. With one connection, transactions are already serial. With several processes on one file, SQLite's reserved lock excludes them.
- Same transaction: the in-process queue serialises callbacks per key. Nested calls with the lock-scoped provider pass through for keys already held.

Callers that need hozon's entry lock use `withBlobLocks` (or `withLocks` on a view). They never lock hozon tables directly.

`BlobServiceParams.lock` is removed. `BlobLock`, `createMemoryBlobLock`, `BlobLockTimeoutError` and `createFileBlobLock` are removed outright. Every hozon blob service has a database, so the database lock covers every use.

#### Per-call providers

```ts
export type BlobServiceParams = {
  // Default provider for calls made without `using`. Must have `blobStoreDefinition` registered.
  db: StoreProvider
  backend: BlobBackend
  codec?: BlobIDCodec
  chunkSize?: number
  limits?: Partial<BlobLimits>
  runtime?: Runtime
  logger?: Logger
}

// Existing limits, plus:
export type BlobLimits = {
  // ...existing fields
  // Total bytes staged at once: fetch sessions (by content length) plus writes in flight in
  // this service. Unset by default: no limit.
  maxStagingBytes: number | undefined
}

// Every operation that touches the database.
export type BlobOperations = {
  write(params: WriteParams): Promise<WriteResult>
  get(id: string): Promise<BlobEntry | null>
  list(params: { limit: number; cursor?: string }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>
  has(id: string): Promise<boolean>
  getChunkDigests(id: string): Promise<Array<Uint8Array>>
  createReadStream(id: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  setPinned(id: string, pinned: boolean): Promise<void>
  delete(id: string, options?: { force?: boolean }): Promise<boolean>
  evict(id: string): Promise<boolean>
  // Refs (section 2), transfers (section 4).
  addRefs(refs: Array<BlobRefInput>): Promise<Map<string, BlobEntry | null>>
  removeRefs(refs: Array<BlobRefInput>): Promise<number>
  removeHolders(params: BlobHolderSelector): Promise<number>
  listRefs(id: string): Promise<Array<BlobRef>>
  findRefs(params: FindRefsParams): Promise<{ refs: Array<BlobRef>; nextCursor: string | null }>
  beginFetch(params: BeginFetchParams): Promise<BeginFetchResult>
  getPresentChunks(params: TransferKey): Promise<Array<number>>
  stageChunk(params: StageChunkParams): Promise<void>
  completeFetch(params: TransferKey): Promise<CompleteFetchResult>
  abortFetch(params: TransferKey): Promise<boolean>
  abortFetches(params: { owner: string } | { ownerPrefix: string }): Promise<number>
  listTransfers(params: ListTransfersParams): Promise<{ transfers: Array<BlobTransferInfo>; nextCursor: string | null }>
  // Canonicalises, then `withBlobLocks` on this view's provider.
  withLocks<R>(ids: Array<string>, fn: (ops: BlobOperations, tx: StoreProvider) => Promise<R>): Promise<R>
}

export type BlobService = BlobOperations & {
  // A view running every operation on `provider`. Shares codec, limits, backend and the
  // in-process staging registry with the service. Cheap; create one per transaction.
  using(provider: StoreProvider): BlobOperations
  // Kept: `using(tx).write` plus `fn` inside one transaction opened on `db`.
  writeWith<T>(params: WriteParams & { fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T> }): Promise<WriteResult & { result: T }>
  pruneStaging(olderThan: Date): Promise<{ removed: number; failed: number }>
  collect(params: CollectParams): Promise<CollectResult>
  drainByteDeletions(params?: { limit?: number }): Promise<{ deleted: number; failed: number }>
  // Section 5. Throws `BlobReconcileUnsupportedError` when the backend has no `listKeys`.
  reconcileBytes(params: ReconcileParams): Promise<ReconcileResult>
  runMaintenance(params: MaintenanceParams): Promise<MaintenanceResult>
  readonly codec: BlobIDCodec
  readonly limits: BlobLimits
}
```

`withLocks` hands `fn` a view bound to the lock-scoped provider. Operations on that view pass through for held keys. Operations on any other view of the same transaction queue behind `fn` and would hang it; the documentation says so and a test pins the right usage.

#### Write path

`write` on a view bound to provider `P`:

1. Check `limits.maxStagingBytes` (below). Validate, stage and hash outside any lock and outside any database call (unchanged, `blob/src/write.ts:116-178`). Register the staging ID and its byte count in the shared registry.
2. `withBlobLocks(P, [blobID], tx => ...)`:
   - read the entry fresh;
   - if `local`: discard staging, fill a null content type, return `created: false`;
   - else `promoteEntry` (keeps `pinned` and `createdAt`), delete every fetch session of the blob, delete its byte-deletion journal row, upsert its release row (section 2), then `backend.commit(stagingID, blobID)` as the last step before the transaction commits.
   - Bytes commit last because Postgres raises `40P01` only on a statement that waits for a lock. Every such statement runs before `backend.commit`, so a deadlock victim rolls back with its staging intact, and the retry commits it. A failure of `COMMIT` itself leaves orphan bytes for `reconcileBytes`. A retry that finds neither its staging nor the committed key rethrows the original error.
3. Staging areas of the deleted sessions are aborted after commit (`tx.onCommit`). On a provider that is not transaction-bound this is right after the call.
4. On a transaction-bound `P`, register `tx.onRollback(() => reclaim(blobID))`. `reclaim` runs in its own transaction, under the lock: if no `local` row exists, `backend.delete(blobID)`.

`writeWith` is `db.withTransaction(tx => { const r = await service.using(tx).write(p); return fn(tx, r.entry) })`. The lock is now held until that transaction commits, `fn` included.

Bytes are still committed before the transaction commits. That is unavoidable: a backend is not transactional. What changes is that nothing can delete them until the row's fate is known, because the lock outlives the callback.

#### Staging limit

`limits.maxStagingBytes` is unset by default. When set, staging in use is the sum of `content_length` over every `blob_fetch_sessions` row plus the bytes of writes in flight in this service's registry. Other processes' writes in flight are not counted; their fetch sessions are.

- `beginFetch` that would create or restart a session checks `in use + content length > maxStagingBytes` and throws `StagingLimitError` before any row or area exists. A resume adds nothing and is never refused.
- `write` with a known length checks before staging. A streamed write without a declared length counts its bytes as they arrive and aborts its staging with `StagingLimitError` once over.
- Reads, serving and `completeFetch` are never limited.

The check is advisory across processes: two processes may both pass it at once. It bounds a runaway, not an exact quota.

#### Long byte I/O and the lock

Holding a transaction on SQLite blocks every writer. So hozon keeps long byte I/O outside the lock when it can:

- Staging writes (`stageChunk`) and whole-blob hashing (`completeFetch`) run before the lock, then the lock re-checks that the session's `stagingID` is unchanged.
- Only `commit`, `delete` and `abortStaging` (fast metadata operations on FS and memory backends) run under the lock.
- When the view's provider is already transaction-bound, the whole operation runs under the lock, I/O included. A read before the lock would establish a SQLite read snapshot that a later writer reservation could invalidate (`docs/reference/db.md`, "acquire locks before establishing a read snapshot"). The caller chose to hold a transaction; it pays for it.

#### Staging registry and `pruneStaging`

The service owns one in-process registry, shared by every `using` view:

- write staging IDs and byte counts, from step 1 until the write returns;
- transfer staging IDs created in a transaction that has not ended (added at `beginFetch`, removed by `onCommit` / `onRollback`).

`pruneStaging` skips both. Other processes stay protected by the age threshold only, as today. The threshold must exceed the longest caller transaction that begins a fetch.

#### Root-bound calls inside a caller transaction

On single-connection SQLite, a call on a root-bound view (or the service itself) from inside a caller transaction opens a second transaction. It waits for the connection the caller holds: a hang (D4).

Hozon detects it where the runtime has async context:

- `@hozon/db` records the open transaction in an `AsyncLocalStorage` context around the `withTransaction` callback, when `AsyncLocalStorage` is available (Node, Bun, Deno).
- On an adapter with a single connection, `withTransaction` on the root provider, started inside that context, throws `TransactionScopeError` (new, beside `KeyLockScopeError`) instead of queuing.
- Calls from unrelated async work are outside the context and queue as today.
- Where async context is absent (Expo, browser sqlocal), hozon cannot tell the caller's own task from unrelated work. There the rule is documented: inside a transaction, use `using(tx)`. A test pins the correct usage on every adapter, and the detection on Node.

#### Deadlock analysis

Lock managers in play: Postgres row and advisory locks; the SQLite writer lock; the per-transaction in-process queue of `withKeyLocks`.

| # | Interleaving | Outcome |
|---|---|---|
| D1 | Caller transaction T1 holds the only SQLite connection and calls a write. Before: the write waited for an in-memory lock held by T2, which waited for the connection. | Gone. The blob lock is taken inside T1's connection. No hozon lock is held while waiting for a connection (I4). |
| D2 | Postgres. T1 holds a caller row lock R, then asks blob lock B. T2 holds B (inside a hozon op whose `fn` touches R), then asks R. | Both waits are in Postgres. The detector aborts one with `40P01`. No hang. Rule for callers: take blob locks first (`withLocks`), then own row locks. |
| D3 | Postgres. T1 locks blobs A then B in two calls; T2 locks B then A. | Detector aborts one. Hozon's own multi-blob operations take all keys in one `withBlobLocks` call (sorted). Callers are told to do the same. |
| D4 | SQLite, one connection. Inside T1, the caller calls a view bound to the root `HozonDB` instead of `using(T1)`. That opens T2, which waits for the connection T1 holds. | With async context: `TransactionScopeError`, no hang. Without: hangs; documented, a test pins `using(tx)`. |
| D5 | One transaction, two concurrent callbacks (`Promise.all`) locking A then B and B then A in separate calls. | The in-process queue deadlocks. Hozon never splits one operation's keys across calls. `withKeyLocks` documents the same rule. |
| D6 | `withLocks(fn)` where `fn` calls an operation on a view not bound to the lock-scoped provider. | That operation queues behind `fn`; `fn` awaits it. Hang. Documented; test pins the right usage. |

Deadlock retry: hozon retries only transactions it opened itself (provider not transaction-bound) on Postgres `40P01`. Up to three attempts in total, with a jittered delay between them. Never inside a caller transaction: the caller owns that retry.

#### Races (section 1)

| # | Interleaving | Guarantee |
|---|---|---|
| L1 | Write W in caller T (Postgres) commits bytes and promotes, T not yet committed. GC or byte deletion G on the same blob. | G blocks on the advisory lock until T ends. On commit it sees `local` and skips. On rollback it sees no row; it may delete the orphaned bytes, which is correct. |
| L2 | Same on SQLite. | G cannot start a write transaction until T ends. Same outcome. |
| L3 | W in T rolls back after `backend.commit` created the key. | `onRollback` reclaim: under the lock, no `local` row, delete. A crash instead leaves orphan bytes, removed by `reconcileBytes`. |
| L4 | W in T rolls back; W2 waits on the lock with the same bytes. | W2 runs after T. `backend.commit` finds the key (W's orphan, correct content) and keeps it. W2 promotes. Reclaim then sees `local` and skips. |
| L5 | `pruneStaging` during a `using(tx)` write. | Registry shared: skipped. |
| L6 | Caller decides from an entry it read, then hozon writes (`insertEntry DO NOTHING` takes no lock today). | Every hozon entry mutation runs under the blob lock. A caller that also decides under `withLocks` serialises with it. |

### 2. Refs and GC

#### Model

A ref is `(blobID, kind, key)`: holder `(kind, key)` keeps blob `blobID`. Hozon does not interpret kinds or keys. A blob may have refs before it has an entry (a holder that needs a blob not fetched yet). Hozon creates no entry for such a ref; the first `write` or `beginFetch` does. A caller reads "no entry" as "not here yet".

```ts
export type BlobHolder = { kind: string; key: string }
export type BlobRefInput = BlobHolder & { blobID: string }
export type BlobRef = BlobRefInput & { createdAt: number }
export type BlobHolderSelector =
  | { kind: string; key: string }
  | { kind: string; keyPrefix: string }
export type FindRefsParams = {
  kind: string
  key?: string
  keyPrefix?: string
  blobID?: string
  limit: number
  cursor?: string
}
export type CollectParams = {
  // Only blobs released before this instant are considered: the grace period.
  releasedBefore: Date
  limit?: number
}
export type CollectResult = { deleted: number; kept: number; failed: number }
```

Constraints: `kind` matches `^[a-z][a-z0-9_-]{0,63}$`. `key` is printable ASCII (`0x20`-`0x7e`), 1 to 512 characters. ASCII keys make the prefix bound exact (`key >= prefix AND key < prefix || '\x7f'`) under byte ordering. A caller whose natural key is longer, or not ASCII, hashes it (for example lowercase base32 of a digest).

Operations:

- `addRefs(refs)`: canonicalise, lock every distinct blob in one `withBlobLocks` call, insert with `ON CONFLICT DO NOTHING`, return the fresh entry (or `null`) per blob. The caller learns, under the lock, whether bytes are there. At most 500 refs per call.
- `removeRefs(refs)` and `removeHolders(selector)`: `DELETE ... RETURNING blob_id`, then upsert a release row for each returned blob with an entry. No lock needed: removal can only make a blob more collectable, and GC re-checks under the lock.
- `listRefs(blobID)`, `findRefs(params)`: keyset pagination on `(kind, key, blob_id)`.
- Pin stays a boolean on the entry. `setPinned(false)` upserts a release row.

#### Release rows and the grace period

`blob_releases(blob_id, released_at)` marks a blob that may have no holder. It is upserted (with `released_at = now`) whenever an operation can leave a blob unheld:

- a ref removed;
- a pin cleared;
- an entry created or promoted (`write`, `completeFetch`, the `remote-only` entry `beginFetch` creates);
- a fetch session ended (`abortFetch`, prune, mismatch, promotion);
- an eviction.

GC deletes stale release rows when it finds the blob held. A later release re-adds it. Release rows are a work list, not the truth: GC decides from refs, pin and sessions under the lock.

The migration inserts no release rows for existing entries. Embedders that never used refs keep every existing blob even if they call `collect`.

Hozon has no default grace period. Every caller passes `releasedBefore` (or `grace` to `runMaintenance`).

#### GC

`collect({ releasedBefore, limit })`:

1. `drainByteDeletions()`.
2. List release rows with `released_at < releasedBefore`, oldest first, up to `limit` (default 100, at most 500).
3. For each blob, its own transaction under `withBlobLocks`:
   - re-read entry, ref count, pin, session count, release row;
   - release row gone or newer than the cutoff: skip;
   - refs, pin or sessions present: delete the release row, count `kept`;
   - no entry: delete the release row;
   - otherwise phase 1: delete the entry (chunks and sessions cascade), insert a byte-deletion journal row if the state was `local`, commit.
4. Phase 2 for each journal row written: own transaction under the lock. If no `local` row exists, `backend.delete(blobID)`. Delete the journal row. Commit.

`drainByteDeletions` runs phase 2 for every journal row. Embedders call it at start, after a crash; `runMaintenance` calls it first.

Why two phases: deleting bytes before the row commits breaks I1 on a crash (row says `local`, bytes gone). Deleting bytes after the commit without a lock lets a writer that committed in between lose its bytes. Phase 2 under the lock, with the `local` re-check, closes both. No generation counter is needed: the decision and the action happen under the same lock.

#### `delete`

`delete(id, { force })` uses the same two phases.

- Without `force`: throws `BlobReferencedError` when refs exist. Pin does not block an explicit delete, as today.
- With `force`: deletes the blob's refs in the same transaction, then the entry.
- On a provider that is not transaction-bound, phase 2 runs inline, so the caller sees bytes gone when `delete` returns, as today.

Teikyo's DELETE answers 409 for a referenced blob. `?force=1` passes `force: true`; who may use it is in section 6.

On a transaction-bound provider, phase 2 for `delete` and `evict` is scheduled with `tx.onCommit` (errors logged) and replayed by the next `drainByteDeletions`.

#### Interactions

- Pin: pinned blobs are never collected. Pin and GC both run under the lock.
- Transfers in progress: a blob with any fetch session is never collected. Stale sessions end through `pruneStaging` or `abortFetch`, which release the blob.
- Staging: GC never touches staging. Staging of a session deleted by cascade cannot occur, since sessions block GC.
- Delete: explicit delete wins over grace. It aborts session staging after commit.
- Evict: an evicted (`remote`) blob with no refs is collected like any other; it has no bytes to delete.

#### Races (section 2)

| # | Interleaving | Guarantee |
|---|---|---|
| G1 | `addRefs` before GC phase 1. | GC sees the ref, keeps the blob. |
| G2 | `addRefs` after phase 1 committed. | `addRefs` returns `null` for the blob. The caller re-writes or fetches. |
| G3 | `addRefs` (Postgres, no lock) would have inserted an uncommitted ref GC cannot see. | Prevented: `addRefs` locks. |
| G4 | Write W between phase 1 and phase 2. | W, under the lock: no row, `commit` keeps the existing key, promote, delete journal row. Phase 2: journal row gone (or row `local`): skip. |
| G5 | Phase 2 holds the lock and deletes; W waits. | W runs after: no key, `commit` publishes its staging. |
| G6 | Phase 2 crashes after `backend.delete`, before commit. | Journal row survives. Next drain: no `local` row, `delete` again (idempotent), clear. A write in between republishes bytes and makes the row `local`; the drain then skips. |
| G7 | Fetch completes between phase 1 and phase 2. | As G4. |
| G8 | Pin set after release, before GC. | GC sees pin, keeps, drops release row. Unpin re-releases. |
| G9 | Ref removed by a caller transaction that rolls back. | The release upsert rolls back with it. GC sees nothing. |
| G10 | Two holders over one blob; one removed. | Count stays above zero. Kept. |
| G11 | Reader opened a stream, then phase 2 deletes. | POSIX: the open file stays readable. Memory: the reader holds the buffer. Windows: unlink fails, phase 2 throws, journal row stays, retried. A reader that opens after phase 2 gets `BlobNotFoundError`. |
| G12 | `delete` without `force` racing `addRefs`. | Serialised. Ref first: `BlobReferencedError`. Delete first: `addRefs` returns `null`. |

### 3. Entry state `remote` and `evict`

#### States

```ts
export type BlobState = 'local' | 'remote' | 'remote-only'
```

- `local`: bytes present, chunk digests verified (computed or verified locally).
- `remote`: was `local`; bytes gone. Content length, content type, `encrypted`, `keyID`, `createdAt`, pin and verified chunk digests kept.
- `remote-only`: created by `beginFetch`. Nothing verified beyond the ID.

`partial` is removed outright, neither stored nor derived. Transfers are per owner (section 4), so "is anything fetching" is a session query (`listTransfers({ blobID })`), not a state. The migration turns existing `partial` rows into `remote-only`.

#### `evict`

```ts
evict(id: string): Promise<boolean>
```

Under the lock: entry must be `local`. A pinned entry throws `BlobPinnedError`; there is no force, since eviction is mostly automated and must not override a pin. Set state `remote`, keep chunk rows, insert a byte-deletion journal row, upsert a release row. Phase 2 as in section 2. Returns `false` when the entry is absent or not `local`. Refs are untouched: that is the point.

#### Reads

- `get`, `list`: return the entry with state `remote`.
- `has`: `false`.
- `createReadStream`: throws `BlobNotLocalError extends BlobNotFoundError`, with `state`. Callers can tell "evicted, re-fetch" from "unknown".
- `getChunkDigests`: `[]` for non-`local`. It feeds manifests served to peers, and bytes are not here.
- Teikyo: GET and `/manifest` answer 404 (state not `local`), as today. `/meta` reports `remote`.

#### Re-population

- `write` of the same bytes: as from any non-local state. Promotion keeps pin and `createdAt`, replaces chunk rows with the writer's layout, clears the journal row.
- `beginFetch` on `remote`: if the manifest's chunk size equals the stored one, its digests must equal the stored verified digests, else `InvalidManifestError` (the peer is wrong; fail before any byte moves). A different chunk size is accepted. The stored verified digests stay in `blob_chunks` during the transfer; the session carries its own manifest (section 4). On completion, promotion replaces them with the session's layout, now verified by the whole-blob hash.
- A failed or aborted transfer leaves the entry `remote`.

#### Races (section 3)

| # | Interleaving | Guarantee |
|---|---|---|
| E1 | `evict` committed; fetch completes before phase 2. | Fetch under the lock: `commit` keeps the existing key, promote `local`, clear journal. Phase 2 skips. |
| E2 | `evict` racing a write. | As E1. |
| E3 | `evict` racing `setPinned(true)`. | Serialised. Pin first: `evict` throws `BlobPinnedError`. Evict first: pin applies to a `remote` entry; bytes still go. Pin does not fetch. |
| E4 | `evict` racing GC. | Serialised. Either order leaves no bytes and, without refs, no row. |

### 4. Transfer owners

#### Model

A transfer session belongs to `(blobID, owner)`. `owner` is printable ASCII (`0x20`-`0x7e`), 1 to 255 characters; hozon does not interpret it. ASCII makes the `ownerPrefix` bound exact, as for ref keys. Sessions of different owners are independent: each has its own staging area, manifest and progress. The first to complete publishes the bytes; the others end.

Any number of owners may fetch one blob in parallel. There is no per-blob cap. Staging space is bounded globally by `limits.maxStagingBytes` when set.

Considered and rejected: one session per blob, taken over by a new owner. Two owners fetching the same blob would restart each other forever, and an owner's progress could be destroyed by another. Per-owner sessions cost staging space instead.

```ts
export type TransferKey = { id: string; owner: string }
export type BeginFetchParams = TransferKey & { manifest: TransferManifest }
export type BeginFetchResult =
  | { status: 'local' }
  | { status: 'started' | 'resumed' | 'restarted'; presentChunks: Array<number> }
export type StageChunkParams = TransferKey & { index: number; bytes: Uint8Array }
export type CompleteFetchResult = {
  entry: BlobEntry
  // false: the entry was already local (a write or another owner won); this owner's staged
  // bytes were not used.
  fetched: boolean
}
export type BlobTransferInfo = {
  blobID: string
  owner: string
  chunkSize: number
  chunkCount: number
  presentCount: number
  createdAt: number
  updatedAt: number
}
export type ListTransfersParams = {
  owner?: string
  ownerPrefix?: string
  blobID?: string
  limit: number
  cursor?: string
}

export class TransferNotFoundError extends BlobNotFoundError {
  readonly owner: string
  // State of the entry when the session was missing: 'local' means another path published it.
  readonly blobState: BlobState | null
}
export class StagingLimitError extends Error {}
export class BlobPinnedError extends Error {}
export class BlobReferencedError extends Error {}
export class BlobNotLocalError extends BlobNotFoundError {
  readonly state: BlobState
}
```

#### Operations

- `beginFetch({ id, owner, manifest })`, under the lock:
  - entry `local`: end this owner's session if any; return `local`;
  - validate the manifest (unchanged rules) and, for `remote`, the verified-digest rule of section 3;
  - this owner has a session with an identical manifest (chunk size, digests, content type, `encrypted`, `keyID`) and its staging exists: touch it, return `resumed`;
  - this owner has a different session: check the staging limit, replace it, return `restarted` (old staging aborted after commit);
  - otherwise: check the staging limit, create a session, return `started`;
  - no entry: insert a `remote-only` entry first and upsert a release row.
  Other owners' sessions are never read for resume and never modified.
- `getPresentChunks({ id, owner })`: this owner's present indexes; resets this session if its staging vanished.
- `stageChunk({ id, owner, index, bytes })`:
  1. read this owner's session (unlocked when the provider is not transaction-bound);
  2. validate index, length and digest against the session manifest;
  3. `backend.writeChunk(session.stagingID, index * session.chunkSize, bytes)`;
  4. under the lock: re-read the session; if it is gone or has another staging ID, abort the old staging ID quietly after commit (the write may have recreated an aborted area) and throw `TransferNotFoundError`; else mark the chunk present and touch the session.
- `completeFetch({ id, owner })`:
  1. read the session; if absent: entry `local` gives `{ entry, fetched: false }`, else `TransferNotFoundError`;
  2. all chunks present, else `TransferIncompleteError`;
  3. hash the staging area (outside the lock when allowed);
  4. under the lock: re-read the session; staging ID changed or session gone: as step 1. Entry already `local`: end this session, return `fetched: false`. Hash mismatch: end only this session, throw `BlobIDMismatchError`. Else promote (metadata from the entry, null fields filled from the session manifest; chunk rows from the session manifest, replacing any stored layout), delete every session of the blob, clear the journal row, upsert a release row, then `backend.commit` last, as in the write path. Staging of ended sessions is aborted after commit.
- `abortFetch({ id, owner })`: under the lock, end this session.
- `abortFetches({ owner })` or `abortFetches({ ownerPrefix })`: page through `listTransfers` with the same selector and abort each session, one lock per blob. Both are served by the `(owner, blob_id)` index; the prefix uses the exact ASCII bound.
- `listTransfers`: keyset pagination; by owner or owner prefix uses the `(owner, blob_id)` index.
- `pruneStaging`: per stale session, under the lock, end that session only.

#### Staging stability

Hashing outside the lock is safe because, once every chunk is present, the only writes to that staging area are re-stages of the same verified bytes at the same offsets. The backend must not change those bytes either.

This becomes part of the `BlobBackend` contract: a staging area whose bytes were written and not re-written reads back the same bytes until `commit` or `abortStaging`. The contract comment in `blob-backend/src/backend.ts` states it. A case in the shared backend suite (`blob-node-fs/test/backend.test.ts`, run against the memory and FS backends) pins it. `@hozon/blob-node-fs` documents that it holds (plain files, written in place, never moved before `commit`).

#### Crash safety

The session row carries the staging ID. Resume needs the row and a staging probe, as today (`blob/src/transfer.ts:149-169`). Staging areas are aborted only after the row change commits.

| Crash point | State after restart | Effect |
|---|---|---|
| After a session row commits, before its staging exists | Row, no area | Resume probes nothing (no chunks); stage creates the area. |
| After `writeChunk`, before the present mark commits | Bytes in staging, chunk not marked | Re-staged on resume. |
| After a session replace commits, before the old area is aborted | Old area orphaned | `pruneStaging`: no session for that ID, older than cutoff, aborted. |
| Owner B begins while owner A's session exists | Two rows, two areas | B never sees A's chunks. No owner can complete with chunks it did not stage. |
| After `backend.commit` in `completeFetch`, before promotion commits | Bytes published under the key, row not `local`, session present, staging consumed | The owner's next `completeFetch` cannot read staging: the session resets. The owner begins again and re-downloads. Its later `commit` finds the key and keeps the bytes. If it never does, `reconcileBytes` removes the orphan. |

#### Races (section 4)

| # | Interleaving | Guarantee |
|---|---|---|
| T1 | Owners A and B, identical manifest. | Independent sessions. B starts from zero. |
| T2 | A completes while B stages. | B's next stage: `TransferNotFoundError` with `blobState: 'local'`. B's complete: `fetched: false`. The caller decides what that means for its owner. |
| T3 | A writes chunk bytes, A's session is replaced (A restarted itself) before A records. | Record sees another staging ID: abort the old area, throw. |
| T4 | Local write lands during sessions. | Write deletes all sessions under the lock. As T2. |
| T5 | `abortFetches({ owner })` or `({ ownerPrefix })` in a caller transaction racing `beginFetch` for a matching owner. | Both lock per blob. Order decides; a begin after the abort commits creates a fresh session. The caller's own check decides whether that is allowed. |
| T6 | Prune during an active stage of the same session. | Prune re-reads `updated_at` under the lock; a stage touched it, so prune skips. |
| T7 | Mismatch for A while B progresses. | Only A's session ends. |
| T8 | A and B complete in parallel. | Serialised by the lock. The first publishes; the second gets `fetched: false`. Neither throws. |
| T9 | Two `beginFetch` for new owners near `maxStagingBytes`. | Under one blob's lock they serialise; across blobs or processes both may pass. Advisory bound, documented. |

### 5. Maintenance and byte reconciliation

#### `listKeys` and `reconcileBytes`

```ts
// @hozon/blob-backend, optional
export type BlobBackend = {
  // ...existing members
  // Enumerate committed keys with their commit time. For reconciliation of orphan bytes.
  listKeys?(): AsyncIterable<{ key: string; modifiedAt: Date }>
}

// @hozon/blob
export type ReconcileParams = {
  // Only keys committed before this instant are considered: the minimum-age guard.
  olderThan: Date
  limit?: number
}
export type ReconcileResult = { scanned: number; deleted: number; failed: number }
```

`@hozon/blob-node-fs` implements `listKeys` (walk of the committed directory, file mtime). `MemoryBlobBackend` implements it too, for tests. `reconcileBytes` throws `BlobReconcileUnsupportedError` when the backend lacks it.

`reconcileBytes({ olderThan, limit })` is opt-in. Hozon never runs it unless asked (directly or through `runMaintenance` with `bytesOlderThan`). For each key from `listKeys` with `modifiedAt < olderThan`:

1. Skip keys that do not decode as a blob ID of the service codec.
2. Under `withBlobLocks`, in its own transaction: if a `local` row exists, skip. Else `backend.delete(key)`.

The minimum age guards a write between `backend.commit` and the row commit in another process, which the lock alone does not cover before that process takes it. It must exceed the longest caller transaction that writes. The lock covers this process and every transaction that already holds it.

#### `runMaintenance`

```ts
export type MaintenanceParams = {
  // GC grace: blobs released longer ago than this are collected.
  grace: number // milliseconds
  // Staging areas (sessions and orphans) untouched for longer than this are pruned.
  stagingOlderThan: number // milliseconds
  // Committed keys without a local row, older than this, are deleted. Omit to skip reconciliation.
  bytesOlderThan?: number // milliseconds
  limit?: number
}
export type MaintenanceResult = {
  drained: { deleted: number; failed: number }
  pruned: { removed: number; failed: number }
  collected: CollectResult
  reconciled: ReconcileResult | null
}
```

One call runs, in order: `drainByteDeletions`, `pruneStaging(now - stagingOlderThan)`, `collect({ releasedBefore: now - grace })`, then `reconcileBytes({ olderThan: now - bytesOlderThan })` when given. Every duration is explicit; hozon has no default grace. A step that throws is logged and the next one still runs; the result reports each. Scheduling is the embedder's.

### 6. Teikyo

#### Content-type hook

```ts
// @teikyo/blob
export type BlobContentTypeResolver = (input: {
  blobID: string
  entry: BlobEntry
  principal: BlobPrincipal | null
  request: Request
  context: BlobRequestContext
}) => Promise<string | null> | string | null

export type BlobHandlersParams = {
  // ...existing fields
  // Content-Type of GET and HEAD on `/:id`. Null or absent result: the default.
  resolveContentType?: BlobContentTypeResolver
}
```

`BlobPluginParams` gains the same field and passes it through. `lock` leaves the `Pick` of `BlobServiceParams` (`teikyo:plugin.ts:45-48`, `:150`).

Behaviour:

- Default, and when the resolver returns `null`: `entry.contentType || 'application/octet-stream'`. Unchanged.
- Called after authorisation and after the `local` check, before building headers. Not called for 404. On a conditional request it is called before the ETag comparison, since the ETag depends on it.
- The principal is the one the authenticator produced, so a resolver can use claims of the verified token or the request URL.
- The result must match `type/subtype` with optional parameters (RFC 9110 media type), at most 255 characters. An invalid result is replaced by `application/octet-stream` and logged at warn. A thrown error propagates (500).
- `ETag`: unchanged (`"<blobID>"`) when no resolver is set or it returns `null`. When it returns a type, `"<blobID>.<h>"`, where `h` is a short hash of the resolved type (first 8 base32 characters of its BLAKE3 digest). Two types of one blob never share an ETag.
- No `Vary`. Guidance in the reference docs: put whatever decides the type in the URL query, so each type has its own URL and cache entry.
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control` are unchanged.
- `/meta` keeps reporting the stored content type. It describes the stored entry, not a request.

#### Delete

- DELETE of a referenced blob answers 409.
- `DELETE /:id?force=1` calls `delete(id, { force: true })`. Teikyo has no admin concept (see Background), so "admin-only" has to map onto the authoriser. A new `BlobAction` `'force-delete'`, checked in addition to `'delete'`; capability `act` `blob/force-delete`, grant resource `blob/force-delete/<id>`. Only principals the embedder's authoriser or grants allow for it may force.

#### Start-up and maintenance

- `blobPlugin` start-up also calls `service.drainByteDeletions()` after `pruneStaging`.
- `BlobPluginParams.maintenance?: { interval: number; grace: number; stagingOlderThan: number; bytesOlderThan?: number }`. Absent by default: no periodic run. When set, the plugin calls `runMaintenance` every `interval` milliseconds, one run at a time, stopped with the plugin. Results are logged at info, failures at error.

## Migration and compatibility

### Schema: new migrations in `@hozon/store-blob`

Applied migrations `0-init` and `1-sessions` are not edited. The result below is split over three new migrations, one per PR (see Release plan): `2-byte-deletions` (`blob_byte_deletions`), `3-holders` (`blob_refs`, `blob_releases`), `4-fetch-sessions` (sessions, session chunks, the backfill).

```
blob_refs
  blob_id text not null
  kind text not null            -- compareText: collate "C" on Postgres
  key text not null             -- compareText
  created_at bigint not null
  primary key ${prefix}_blob_refs_pkey (blob_id, kind, key)
  index ${prefix}_blob_refs_holder_idx (kind, key, blob_id)
  -- no foreign key: refs may precede the entry

blob_releases
  blob_id text not null primary key ${prefix}_blob_releases_pkey
  released_at bigint not null
  foreign key -> blob_entries(blob_id) on delete cascade
  index ${prefix}_blob_releases_at_idx (released_at)

blob_byte_deletions
  blob_id text not null primary key ${prefix}_blob_byte_deletions_pkey
  queued_at bigint not null
  index ${prefix}_blob_byte_deletions_at_idx (queued_at)
  -- no foreign key: the entry is usually gone

blob_fetch_sessions
  blob_id text not null
  owner text not null           -- compareText; printable ASCII, at most 255
  staging_id text not null unique
  content_length bigint not null
  chunk_size integer not null
  content_type text
  encrypted integer not null default 0
  key_id text
  created_at bigint not null
  updated_at bigint not null
  primary key ${prefix}_blob_fetch_sessions_pkey (blob_id, owner)
  foreign key -> blob_entries(blob_id) on delete cascade
  index ${prefix}_blob_fetch_sessions_owner_idx (owner, blob_id)

blob_fetch_chunks
  staging_id text not null
  index integer not null
  digest binary not null
  present integer not null default 0
  primary key ${prefix}_blob_fetch_chunks_pkey (staging_id, index)
  foreign key (staging_id) -> blob_fetch_sessions(staging_id) on delete cascade
```

`content_length` serves the staging limit sum without decoding blob IDs.

Backfill, in the migration:

1. Delete `blob_chunks` rows of `partial` entries (unverified manifests).
2. Set `partial` entries to `remote-only`.
3. Drop `blob_transfers`, then `blob_transfer_sessions`. Their staging areas become orphans; `pruneStaging` reclaims them (no session for the `t-` ID).
4. Insert no release rows.

Each `down` drops its own tables; `4-fetch-sessions` also recreates the two dropped ones empty. The backfill is not reversible (as in `1-sessions`).

Statement sizes: refs insert 4 bindings per row, 125 rows per statement; session chunks 4 per row, 125 rows; release upserts 2 per row, 250 rows; `IN` lists through `chunk()` at 500.

### Store API (`BlobStoreAPI`)

Removed: `beginTransfer`, `recordTransferChunk`, `getPresentChunkIndexes`, `finalizeTransfer`, `getTransfer`, `getTransferByStagingID`, `touchTransfer`, `resetTransfer`.
Added (every mutator documented as "call under `withBlobLocks`"; none calls `.transaction()`, all use `withStoreTransaction`): `insertRefs`, `deleteRefs`, `deleteRefsByHolder`, `countRefs`, `listRefs`, `findRefs`, `upsertReleases`, `listReleases`, `deleteRelease`, `enqueueByteDeletion`, `listByteDeletions`, `deleteByteDeletion`, `setState`, `getSession`, `listSessions` (by owner, owner prefix or blob), `getSessionByStagingID`, `putSession`, `markSessionChunk`, `deleteSession`, `deleteSessions`, `touchSession`, `sumSessionContentLength`.
Changed: `promoteEntry` also deletes sessions, the journal row and upserts a release row, and replaces chunk rows with the given layout; `BlobState` loses `partial`, gains `remote`.

### Compatibility summary

| Package | Change | Breaking |
|---|---|---|
| `@hozon/db` | `TransactionScopeError`; async-context detection of a root-bound transaction inside a caller transaction on single-connection adapters | no (a former hang now throws) |
| `@hozon/store-blob` | migrations `2-byte-deletions`, `3-holders`, `4-fetch-sessions`; store API; `BlobState` | yes |
| `@hozon/blob` | `lock` param removed; transfer calls take `owner` and return results; `completeFetch` result shape; `delete` refuses referenced blobs without `force`; `evict` refuses pinned blobs; new errors; `using`, refs, GC, `evict`, `abortFetches`, `reconcileBytes`, `runMaintenance`; `limits.maxStagingBytes`; deadlock retry with jitter | yes |
| `@hozon/blob-backend` | `BlobLock`, `createMemoryBlobLock`, `BlobLockTimeoutError` removed; optional `listKeys`; staging stability stated in the contract | yes |
| `@hozon/blob-node-fs` | `createFileBlobLock` removed; `listKeys` implemented; staging stability documented | yes |
| `@teikyo/blob` | `lock` removed from params; `resolveContentType` added; ETag carries the resolved type; `/meta` state values change; DELETE of a referenced blob answers 409, `?force=1` behind a new action; optional `maintenance` | yes |

Teikyo users without refs or a resolver see no behavioural change except: `/meta` never reports `partial`; in-progress fetches (teikyo does not start any) are dropped by the migration; a held blob cannot be deleted without force.

## Testing

Hozon's blob tests run on SQLite only today (`blob/test/helpers.ts`). The race tests below need a Postgres harness in `@hozon/blob` (devDependency `@hozon/postgres`, same container setup as the conformance runner). They run in the heavy slot. A gated backend wraps the memory backend and parks `commit`, `delete`, `writeChunk` or `createStagingReadStream` until the test releases it, to force each interleaving.

### Locking and providers (`blob/test/locking.test.ts`, SQLite and Postgres)

- A write in an uncommitted caller transaction blocks a byte deletion of the same blob until commit; the bytes stay (L1, L2).
- A direct GC run during that transaction waits, then keeps the entry, with no further run needed.
- A caller transaction rolled back after a write leaves no row; the reclaim deletes the orphan bytes; a second writer queued behind it keeps them (L3, L4).
- `pruneStaging` skips a write in flight through a `using(tx)` view (L5).
- `withLocks([a, b])` in two transactions in opposite order completes; operations inside use the lock-scoped view (D3, D6).
- Postgres: caller row lock then blob lock against blob lock then row lock raises `40P01` within the test timeout, never hangs (D2).
- A hozon-opened transaction that loses a deadlock is retried, at most three attempts in total, with distinct delays; a caller transaction is not retried and sees `40P01`.
- Every entry mutation waits for a caller holding `withLocks` on that blob (L6).
- Node, single-connection SQLite: a call on the root-bound service inside a caller transaction throws `TransactionScopeError`; the same call through `using(tx)` succeeds; an unrelated concurrent call queues and succeeds after commit (D4).
- `limits.maxStagingBytes`: a write over the limit throws `StagingLimitError` and leaves no staging; a streamed write without a length aborts once over; reads are unaffected.

### Refs and GC (`blob/test/gc.test.ts`, `store-blob/test/refs.test.ts`)

- An unheld, unpinned blob past grace loses row and bytes; the journal clears.
- A blob released inside grace is kept.
- A ref added before phase 1 keeps the blob; one added after returns `null` (G1, G2).
- A crash between phase 1 and phase 2 is replayed by `drainByteDeletions` (G6).
- A journal row whose bytes are already gone is cleared.
- A write between phase 1 and phase 2 keeps its bytes (park `delete`) (G4, G5).
- A fetch completing between phase 1 and phase 2 keeps its bytes (G7).
- A pin set after release keeps the blob, even once unpinned until grace passes again; a pinned blob is never collected (G8).
- A blob with a fetch session is never collected; after `abortFetch` it is.
- Two holders over one blob: removing one keeps it; removing both releases it (G10).
- `removeHolders` in a caller transaction that throws releases nothing (G9).
- `findRefs` by kind and key, by key prefix, by blob; keyset pages; 600 refs inserted and removed without a statement over 500 bindings.
- A prefix query never matches a key that only shares a shorter prefix (`ab` vs `a`).
- A ref for a blob with no entry is stored; `get` stays `null`; a later `beginFetch` creates the entry and GC keeps it.
- `delete` of a referenced blob throws `BlobReferencedError` and changes nothing; `force` deletes refs, row and bytes; `delete` racing `addRefs` (G12).
- Entries existing before migration `3-holders` have no release row and survive `collect`.

### Maintenance and reconciliation (`blob/test/maintenance.test.ts`)

- `reconcileBytes` deletes a committed key with no row older than the cutoff; keeps a newer one, a `local` one and a key that does not decode.
- A key committed by a write whose transaction is still open is kept (lock and age guard).
- A backend without `listKeys` throws `BlobReconcileUnsupportedError`; `runMaintenance` without `bytesOlderThan` never calls it.
- `runMaintenance` runs drain, prune, collect, reconcile in that order (gated backend records calls), reports each, and continues past a failing step.
- Orphan bytes after a crash between `backend.commit` and the row commit are removed by `reconcileBytes`.

### Remote and evict (`blob/test/evict.test.ts`)

- `evict` keeps metadata, refs and verified digests, drops bytes; `has` is false; reads throw `BlobNotLocalError`.
- A fetch re-populates a `remote` entry; pin and `createdAt` survive.
- A manifest with the stored chunk size and other digests is refused before any session exists.
- A manifest at another chunk size is accepted and replaces the layout on completion.
- `evict` of a pinned blob throws `BlobPinnedError` and changes nothing (E3).
- `evict` racing a write or a fetch completion keeps the bytes and leaves `local` (park `delete`) (E1, E2).
- A `remote` entry with no refs is collected; no backend delete is issued (E4).

### Transfer owners (`blob/test/transfer.test.ts`, extended)

- Same owner resumes; only missing chunks are staged.
- Another owner with an identical manifest starts from zero, with a new staging ID; no chunk of the first owner reaches its completion (T1).
- The first owner continues after the second begins; whoever completes first publishes; the other gets `fetched: false`, and `TransferNotFoundError` with `blobState: 'local'` on stage (T2).
- Two owners complete in parallel: one `fetched: true`, one `fetched: false`, neither throws (T8).
- A stage after `abortFetch` throws `TransferNotFoundError`; the area it recreated is removed.
- A whole-blob mismatch ends only that owner's session (T7).
- A local write during sessions ends all of them (T4).
- `abortFetches({ owner })` ends that owner's sessions only; `abortFetches({ ownerPrefix: 'owner-a/' })` ends `owner-a/1` and `owner-a/2`, never `owner-ab/1`; others stay (T5).
- Restart over the same database and backend resumes; over a fresh backend it restarts from zero.
- A crash after a session replace leaves an orphan area that `pruneStaging` reclaims.
- `limits.maxStagingBytes`: a new session over the limit throws `StagingLimitError`; a resume is never refused; unset means unlimited (T9).
- An owner of 256 characters, or with a non-ASCII character, is refused.
- `listTransfers` by owner, owner prefix and blob, paged.
- Stage and complete through a transaction-bound view run fully under the lock.

### Backend contract (`blob-node-fs/test/backend.test.ts`, memory and FS)

- A fully written staging area reads back the same bytes until `commit` or `abortStaging`, including after a re-stage of the same chunk.
- `listKeys` lists committed keys with a commit time, never staging areas.

### Migration (`store-blob/test/migration.test.ts`, extended)

- A database at `1-sessions` with a `partial` entry, a session and present chunks migrates through `4-fetch-sessions`: entry `remote-only`, chunks gone, old tables gone, new tables empty, no release rows.
- `down` restores the old table shapes.

### Teikyo (`teikyo:test/read.test.ts`, `teikyo:test/plugin.test.ts`, extended)

- No resolver: unchanged headers and ETag (current tests pass untouched).
- A resolver reading a query parameter serves two types for one blob ID, with two ETags of the form `"<blobID>.<h>"`; a conditional request with one type's ETag gets 304 only for that type.
- `null` result falls back to the stored type, then octet-stream, with the plain ETag.
- An invalid result serves octet-stream and logs a warning.
- A throwing resolver answers 500.
- 404 paths do not call the resolver; HEAD does. No `Vary` header.
- `/meta` reports the stored type with a resolver set.
- `nosniff` and `sandbox` are always present.
- DELETE of a referenced blob answers 409; `?force=1` without the force action answers 403; with it, the blob, its refs and bytes go.
- Plugin start-up drains byte deletions.
- `maintenance` absent: no periodic run. Set: `runMaintenance` runs on the interval, never overlapping, and stops with the plugin.

## Release plan

Three hozon PRs, each with its own new migration, released together:

1. Locking and providers: `withBlobLocks`, `using`, lock param and `BlobLock` family removed, write and delete on the DB lock, two-phase delete with `blob_byte_deletions`, deadlock retry, `TransactionScopeError` in `@hozon/db`, `maxStagingBytes` for writes. Migration `2-byte-deletions`.
2. Refs, GC, `remote`, `evict`, `delete` force, `listKeys`, `reconcileBytes`, `runMaintenance`: `blob_refs`, `blob_releases`. Migration `3-holders`.
3. Transfer owners: `blob_fetch_sessions`, `blob_fetch_chunks`, `partial` removed, `abortFetches` by prefix, `maxStagingBytes` for fetches, staging stability contract. Migration `4-fetch-sessions`.

Versions (0.x, so breaking means minor):

| Package | From | To |
|---|---|---|
| `@hozon/db` | 0.5.0 | 0.5.1 |
| `@hozon/store-blob` | 0.4.0 | 0.5.0 |
| `@hozon/blob` | 0.3.0 | 0.4.0 |
| `@hozon/blob-backend` | 0.2.0 | 0.3.0 |
| `@hozon/blob-node-fs` | 0.2.0 | 0.3.0 |
| `@teikyo/blob` | 0.3.1 | 0.4.0 |

Order: hozon PRs merged and published; teikyo bumps its hozon range, drops `lock`, adds the resolver, the ETag rule, the delete rules and `maintenance`, publishes; consumers adopt. Release mechanics follow the `kigu:releasing` skill. Docs updated with each PR: `docs/reference/db.md` (transaction scope), `docs/reference/stores/blob.md`, `docs/reference/blob-backends.md` (lock section removed, `listKeys`, staging stability), teikyo README and reference (resolver, ETag, URL-query guidance, force, maintenance).

## Resolved decisions

- Lock: `BlobLock` and the file lock are removed outright; every service has a database.
- Adapters: `withKeyLocks` is covered by the conformance sync cases on node-sqlite, Postgres, expo, sqlocal and electron.
- Root-bound call inside a caller transaction (D4): detected through async context and thrown as `TransactionScopeError`; documented and pinned by a test where async context is absent.
- Orphan bytes: optional `BlobBackend.listKeys()` plus opt-in `reconcileBytes()` under the lock with a minimum-age guard; `@hozon/blob-node-fs` implements it.
- Parallel sessions: no per-blob cap; optional global `limits.maxStagingBytes`, unset by default, enforced on `beginFetch` and writes.
- `partial`: dropped outright; fetch status through `listTransfers({ blobID })`.
- Re-fetch at another chunk size: accepted; promotion replaces the stored layout.
- Scheduling: one-shot `runMaintenance({ grace, stagingOlderThan, bytesOlderThan })`, all explicit, no default grace; teikyo `maintenance` config, off by default.
- Delete of a held blob: `BlobReferencedError` unless `{ force: true }`; teikyo 409. Teikyo `?force=1` needs the new `BlobAction` `'force-delete'` (capability `blob/force-delete`, grant `blob/force-delete/<id>`); embedders that never grant it refuse forced deletes.
- Ref constraints: `kind` pattern and printable ASCII keys of at most 512 characters; longer keys are hashed by the caller.
- Evict of a pinned blob: `BlobPinnedError`, no force.
- Content type: `/meta` keeps the stored type; ETag carries the resolved type; type-deciding input belongs in the URL query; no `Vary`.
- No stub: refs without an entry are allowed; `beginFetch` creates the entry.
- Staging stability: part of the `BlobBackend` contract, with a backend suite case, documented on `@hozon/blob-node-fs`.
- Deadlock retry: only hozon-opened transactions, on `40P01`, three attempts with jitter.
- Retry and bytes: `write` and `completeFetch` run `backend.commit` after every database statement of the locked transaction, so a deadlock victim keeps its staging for the retry.
- Owners: printable ASCII, at most 255 characters; `abortFetches({ ownerPrefix })` served by the `(owner, blob_id)` index.

## Open questions

None.
