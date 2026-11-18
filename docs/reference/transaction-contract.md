# Transaction contract

Hozon owns transaction scope above the driver. TypeScript store operations and native kernels share the same transaction connection.
Local writes can cover preparation, signing, apply and resolver reads in one transaction.
Operations spanning graph, blob, connector and peer stores remain atomic.
A native kernel must never open an independent transaction within that scope.

## Handles and scoped providers

The native driver exposes `begin(kind: 'read' | 'write')`, returning a `txID`.
Every TypeScript statement and native kernel names its `txID` and runs on that transaction's connection.
TypeScript statements use the `@hozon/native` Kysely driver.
`savepoint`, `releaseSavepoint`, `rollbackTo`, `commit` and `rollback` all take a `txID`.
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

- The FIFO admission queue holds `begin('write')` requests until the active writer finishes.
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
The clocks are `CLOCK_UPTIME_RAW` on iOS and `uptimeMillis` on Android.
Expiry fails the admission with a diagnostic naming both stacks.

Release builds never expire admissions or automatically break ownership.
Once a wait exceeds a threshold, the driver logs one warning and records a metric.
A caller bug that deadlocks remains a deadlock, as on today's single-connection SQLite adapters.
These admission rules specify native driver behaviour. Conformance liveness bounds are test limits, not implementations of that timeout.

## Commit ordering and hooks

Commit releases the writer as soon as SQLite commits, before JavaScript commit hooks or events run.
Hozon's synchronous, isolated commit hooks then run as today.
The engine subsequently emits scope changes, followed by mutation events.
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
The TypeScript wrapper calls it after every native write kernel, before any listener or later TypeScript read.
Selective invalidation remains deferred until profiling justifies named loaders and a mapping from store keys to loaders.

## Conformance coverage

`transactionContractCases` covers writer admission progress, nested rollback, savepoint loader coherence, key locks, connection-bound writes and concurrent branch atomicity.
It also covers commit-hook writes and capability-selected outside reads.
The node-sqlite transaction-contract suite runs these cases against a real in-memory SQLite adapter.
