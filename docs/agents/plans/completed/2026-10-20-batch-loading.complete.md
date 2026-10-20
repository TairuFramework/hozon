# Batch loading for stores

Status: complete (branch `design/batch-loading`)

## Goal

Store consumers, LLM-generated code especially, read rows one ID at a time in `Promise.all` or loops. The goal is a pit of success. Naive concurrent `store.getX(id)` calls must batch into one query automatically, without a reviewer asking for a multi-ID rewrite. kubun has the same problem and inherits this when it adopts hozon.

## What was built

- **Batch primitives in `@hozon/db`.** `assertBatchSize(size, max, batchLimit?)`, `BatchLimitError`, `BatchReadOptions`, and `iterateBatches(keys, load, { batchSize, signal })`. The last one dedupes, chunks sequentially and yields `{ keys, results }` per query.
- **`createBatchLoader`.** It merges same-tick `load(key)` calls into one batch, dedupes in-flight keys and splits at `maxBatchSize`. It remembers results only when its `remember()` callback allows. Per-key generations stop a late or superseded result from being remembered. They are dropped whenever nothing is in flight, so memory stays bounded.
- **Scopes and `StoreContext`.** `createAPI` receives a third `context` argument with `createLoader`, so the DB owns every loader.
  - `HozonDB.withScope(fn)`, also an optional `StoreProvider` member, gives store instances that remember results until `fn` settles.
  - Transactions remember for their lifetime.
  - Savepoint create, release and rollback, and transaction end, dispatch pending batches first.
  - Savepoint rollback clears memory before its hooks run.
  - A transaction committed from a scope clears the scope before commit hooks run.
- **`@hozon/store-blob`.** `getEntries(ids, options?)` reads at most 500 IDs in one query. Every requested ID is present in the result, with `null` for missing ones, and it never uses remembered values. `getEntry` goes through a loader. All ten mutations dispatch pending reads first and clear the ID in `finally`.
- **`@hozon/blob`.** Every entry re-read under `BlobLock` uses a fresh read (`getEntries([id])`).
- Reference docs, the `hozon:database` skill triggers, and release intents. `@hozon/db` and `@hozon/store-blob` are minor bumps, `@hozon/blob` a patch.

## Key design decisions

- **Hand-rolled instead of `graphql/dataloader`.** DataLoader's cache lives on the loader. With caching off it does not dedupe keys within a batch. It also needs ordered arrays where hozon returns a `Map`. A small native helper keeps runtime dependencies to Kysely and stack packages.
- **Fresh outside scopes, remembered only inside.** Outside a scope, a result is never kept past its batch dispatch. Scopes are always explicit. There is no `AsyncLocalStorage`.
- **Only a pending batch can be joined.** Once a batch is dispatched, new calls start a new batch. This avoids joining a read that began before another connection committed.
- **Three read paths.** These are a capped batch read (store-specific), `iterateBatches` (generic and explicit about query count), and the loader-backed per-ID read. A batch read never chunks internally. `batchLimit` can only lower the store maximum.
- **Program order.** On a single connection (SQLite, Expo, any transaction), a write dispatches the store's pending reads first, so earlier reads never observe it. On a postgres pool outside a transaction, a read and a write started concurrently stay unordered, as before. Writes never wait for reads.
- **Writes through other providers can be stale inside a scope.** This is acceptable for request scopes. Code needing freshness uses the batch read.
- **Sequential `await` loops do not batch.** The docs point to the batch read or `Promise.all`.
- **`getTransfer` stays unbatched.** A batched form would load every present chunk index for up to 500 blobs, an unbounded result.

## Follow-on

See [batch loading follow-ups](../backlog/2026-10-20-batch-loading-follow-ups.md).
