# Transaction contract

Hozon owns transaction scope above the driver. TypeScript store operations and native kernels share the same transaction connection.
Local writes can cover preparation, signing, apply and resolver reads in one transaction.
Operations spanning graph, blob, connector and peer stores remain atomic.
A native kernel must never open an independent transaction within that scope.

## Handles and scoped providers

`@hozon/adapter` exports the injected `NativeSQLite` contract and its value types.
`open(path, { readers, busyTimeoutMs, journalMode: 'wal' })` returns an opaque string `NativeDBHandle`.
`beginWrite(db, { timeoutMs }?)` synchronously returns a `NativePendingAdmission`:
`{ admissionID, granted: Promise<NativeAdmission> }`, with opaque string identifiers.
The ID is assigned at submission; `abandon(db, admissionID)` accepts it while pending or granted,
so a JS admission timeout cancels immediately without waiting for the grant.
`granted` resolves with `{ admissionID, txID }` or rejects on expiry, abandon or database close.
The settled admission retains `admissionID` to keep existing grant-based cleanup unchanged.
`commit(db, txID)`, `rollback(db, txID)` and `abandon(db, admissionID)` name their database explicitly.
`execute(db, txID | null, sql, params, mode)` returns rows as arrays, column names,
and bigint `changes` and `lastInsertRowID`. Values are null, number, bigint, string or `Uint8Array`.
`mode` is `read` or `write`; a null `txID` routes to an outside reader or an admitted autocommit write.
`close(db)` releases the handle.
Every TypeScript statement and native kernel names its `txID` and runs on that transaction's connection.
TypeScript statements use the `@hozon/native` Kysely driver.
Savepoints, release and rollback-to are SQL statements executed with that same `txID`.
These handles describe the native driver contract, rather than new methods on today's adapters.

Hozon keeps these semantics in TypeScript:

- `withTransaction` passes a scoped `StoreProvider` explicitly through the call chain.
- A transaction-bound provider runs nested `withTransaction` work inline. An outer rollback also removes nested writes.
- `withKeyLock(s)` opens a transaction for an unbound provider and reuses a bound provider's transaction.
- `compareWrite` runs on its supplied connection. Transaction-local reads see its writes before commit.
- Savepoint overlap checks and loader dispatch barriers remain unchanged.
- The driver maps each Hozon transaction explicitly to its `txID`. No ambient or global transaction state participates.

`mapConcurrent` within a transaction is safe only when all branches use the same provider and lock ancestry.
It does not make independent root writers safe.

## Writer scheduling and autocommit

The native driver has one write connection and two separate queues:

- The FIFO admission queue holds `beginWrite` requests until the active writer finishes.
  Autocommit writes without a `txID` use this same queue as single-statement transactions.
- The active-command queue runs statements, kernels, savepoints, commit and rollback for the active `txID`.
  A pending admission never blocks active commands. Transaction A can finish while transaction B waits.

JavaScript orchestration retains the writer while awaiting JavaScript work inside its transaction, as it does today.
A native kernel runs to completion on the writer thread and never calls JavaScript.
Callbacks into JavaScript, including MLS seal/open callbacks, run outside kernels.

## Read routing and adapter capability

Reads within a write transaction use its connection and see its own uncommitted writes.
The native driver routes outside reads to pooled WAL readers, which see the last committed state while the writer remains active.
Concurrent outside reads are new native driver behaviour.

Today's single-connection adapters, including node-sqlite and expo, queue outside reads behind the active writer.
An outside read issued during a write transaction completes after commit and sees committed rows without deadlock.
One issued before rollback completes after rollback and sees the pre-transaction state.
Active commands must keep progressing while the outside read waits.

Conformance callers declare adapter capabilities through `ConformanceContext.capabilities`.
`concurrentReaders: true` enables cases requiring outside reads to complete while a writer remains open.
An omitted or false flag selects the queued-read commit and rollback cases instead.
Cases declare their required flag value through `ConformanceCase.capabilities`.
The portable runner filters incompatible cases before creating adapters. Its results and summary count only executed cases.
The Vitest suite reports incompatible cases as skipped.
This flag belongs to conformance configuration and does not modify production adapters.

`admissionControl: true` additionally enables native timeout, abandonment and expiry/grant race cases.
It defaults to false; node-sqlite skips these cases. All required capabilities must match.
Native suites supply the test-only `ConformanceContext.admissionControl(adapter)` factory,
returning `{ sqlite, db, timeoutMs }` for that case's adapter-owned native handle.
The adapter must close the handle during runner cleanup. Set a short positive `timeoutMs`
(for example 10 ms, below the suite's 1000 ms liveness bound); cases pass it to queued `beginWrite` calls.
This injection does not change the production admission default.

## Root reentry, admission timeout and abandonment

Calling root `db.withTransaction` from within an existing transaction is a caller bug.
Hermes has no async context, so Hozon cannot reliably throw `TransactionScopeError` for this situation.
A wait cannot distinguish root reentry from ordinary contention. The native driver therefore treats admission time as a diagnostic.

Each pending write admission has an admission ID.
In one critical section, the driver either grants or expires an admission, never both.
An expired admission leaves the queue, receives no `txID` and owns nothing.

If JavaScript rejects or abandons a request after grant, it calls `abandon(admissionID)`.
This includes a JavaScript timeout firing just after grant.
The driver rolls back the granted transaction and frees the writer. A JavaScript timeout never merely drops a granted handle.

In development and test builds, `begin` records the caller stack and grant records the holder stack.
The default admission timeout is 10 seconds of monotonic time excluding suspension.
The clocks are `CLOCK_UPTIME_RAW` on Apple and `CLOCK_MONOTONIC` on Linux and Android.
Expiry fails the admission with a diagnostic naming both stacks.

Release builds never expire admissions or automatically break ownership.
Once a wait exceeds a threshold, the driver logs one warning and records a metric.
A caller bug that deadlocks remains a deadlock, as on today's single-connection SQLite adapters.
These admission rules specify native driver behaviour. Conformance liveness bounds are test limits, not implementations of that timeout.

## Commit ordering and hooks

Commit releases the writer as soon as SQLite commits, before JavaScript commit hooks or events run.
Hozon's synchronous, isolated commit hooks then run as today.
The engine subsequently emits scope changes, then lifecycle events, then mutation events.
Listeners and commit hooks can start new root writes because the writer is already free.

In-transaction hooks remain in TypeScript. Kernels return control between steps so TypeScript can call those hooks.
A throwing in-transaction hook rolls back the transaction.
Document-applied and document-bytes listeners can therefore write blob references atomically with document changes.

## Savepoints and loader coherence

Hozon's loader registry contains anonymous loaders exposing only `dispatch` and `clearAll`.
It has no mapping from store keys to loaders.
Savepoint rollback retains the dispatch barriers and clears the whole registry, so later reads see the pre-savepoint value.

Phase 1 runs no native write kernels. Writes still use Kysely store code, preserving today's loader behaviour.
For phase 3a, phase 1 adds `invalidateTransactionLoaders(tx)` with a dispatch barrier followed by `clearAll`.
Call it on the owning `HozonDB` with an active transaction provider (including a savepoint or key-lock provider).
It dispatches pending batches synchronously before clearing the transaction registry;
pending results still settle, but cannot restore stale remembered values.
Root, foreign, settled transaction and released savepoint providers are rejected.
The TypeScript wrapper calls it after every native write kernel, before any listener or later TypeScript read.
Selective invalidation remains deferred until profiling justifies named loaders and a mapping from store keys to loaders.

## Conformance coverage

`transactionContractCases` covers writer admission progress, nested rollback, savepoint loader coherence, key locks, connection-bound writes and concurrent branch atomicity.
It also covers a throwing in-transaction listener (including its own writes), explicit loader invalidation,
commit completion before hooks and a follow-up hook writer, and capability-selected outside reads.
Native admission cases verify timeout diagnostics naming caller and holder, continued holder progress,
rollback and writer release after abandonment, rejection of an abandoned `txID`, and exclusive expiry/grant
while releasing a holder before, at and after the short admission deadline. Each race outcome must leave
the writer available; an expired request must not secretly retain a granted transaction.
The Rust suite separately stresses the critical section with an injected clock.
The node-sqlite transaction-contract suite runs these cases against a real in-memory SQLite adapter.
