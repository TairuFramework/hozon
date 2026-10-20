# Batch loading for stores -- design

## Intent

Store consumers often read rows one at a time. They loop with `await store.getX(id)` or call `Promise.all(ids.map((id) => store.getX(id)))`. LLM-generated code produces this shape by default. Today every call is a separate query. On Expo every query is an async native call behind a mutex, so the cost adds up.

The goal is a pit of success. Naive concurrent per-ID code must batch automatically. No reviewer must ask for a `getMany` rewrite.

kubun has the same problem in its GraphQL resolvers and access checks. kubun still uses its own stores. It will adopt hozon later and inherit this work then.

## Goals

- A per-ID read such as `getEntry(id)` merges with other calls made in the same tick into one `IN (...)` query.
- Duplicate IDs in one batch are fetched once.
- Inside an explicit scope, results are remembered for the scope's lifetime.
- A multi-ID read is explicit about batch size and about which IDs were found.
- Store authors write one batch read. A shared `@hozon/db` helper derives the per-ID read.

## Non-goals

- Caching across scopes, or any time-based cache.
- Implicit scopes (`AsyncLocalStorage` or similar). Scopes are always opened explicitly for now.
- Batching reads by filter or by trace (`queryLogs`, `getTraceLogs`, `getSpans`). Only reads by ID are in scope.
- Batching blob bytes. Bytes are already streamed by key from a `BlobBackend`.
- Converting `store-log` and `store-telemetry`. Nothing loops over trace IDs today.
- A kubun migration guide.
- Batching sequential loops (`for (...) await store.getX(id)`). Each call waits for the previous one, so every batch holds one ID. Inside a scope, only repeated IDs benefit. The reference docs must state this and point to the batch read or `Promise.all`. A lint rule that flags the pattern is possible follow-up work.

## Anti-goals

- A per-ID read outside a scope returns a stale value. Outside a scope, every call that starts after a batch was dispatched must hit the database.
- A multi-ID read silently issues many queries or loads an unbounded result.
- A statement binds more than 500 parameters.
- Store methods call `.transaction()` directly. They keep using `withStoreTransaction`.

## Decisions

### Do not use `graphql/dataloader`

The batch-per-tick idea is sound, so the design borrows it. The package does not fit, for these reasons:

- Its cache lives on the loader object. "Fresh outside a scope, remembered inside" would need loaders swapped per scope plus `cache: false` tricks.
- With `cache: false` it does not dedupe repeated keys within one batch. In-flight dedup is a goal.
- Its batch function must return an ordered array. hozon batch reads return a `Map`.
- hozon runtime dependencies are only `kysely`, `@noble/hashes`, and stack packages. A small native helper keeps it that way.

### Three read paths per entity

Each batched entity exposes three paths. Only the batch read is store-specific.

```ts
// Store-specific. One query. Throws BatchLimitError above the limit.
getEntries(
  ids: Array<string>,
  options?: { batchLimit?: number },
): Promise<Map<string, BlobEntry | null>>

// Generic, in @hozon/db. Dedupes, chunks, yields one batch per query.
for await (const { keys, results } of iterateBatches(ids, (chunk) => store.getEntries(chunk))) {
  // keys: the chunk; results: Map with every key present
}

// Per-ID, derived from getEntries by the loader helper.
getEntry(id: string): Promise<BlobEntry | null>
```

### Batch read contract

- Every requested ID is a key in the returned `Map`. `null` means not found. Therefore `results.size` equals the number of unique requested IDs.
- Duplicate input IDs are allowed and deduped.
- An empty input returns an empty `Map` without a query.
- Each store declares a maximum batch size per batch read. The maximum is 500 minus any other parameters the query binds.
- `options.batchLimit` can lower the limit for one call. A value above the store maximum throws.
- More unique IDs than the effective limit throws `BatchLimitError`. The batch read never chunks internally.

### `iterateBatches` helper

- Lives in `@hozon/db`, beside `chunk`.
- Dedupes the IDs, splits them by a `batchSize` option, and calls the batch read once per chunk.
- Yields `{ keys, results }` per chunk, so batch boundaries and query count stay visible.
- Runs chunks sequentially. Memory stays bounded to one batch.
- Accepts an optional `signal`. Aborting stops further chunks and makes the generator throw `signal.reason`.
- Builder's choice: build on `prefetchOrdered` from `@sozai/async` with `window: 1`, or implement directly. Adding the `@sozai/async` dependency to `@hozon/db` is acceptable.
- No window option for now. Parallel chunk queries only help postgres with a pool, because SQLite, Expo, and transactions serialise queries. A window option can be added later.

### Loader helper

A `@hozon/db` helper, provisionally `createBatchLoader`, turns a batch read into a per-ID read.

- Calls made in the same tick are collected into one pending batch. The batch dispatches through the batch read, split at the store maximum.
- Only a pending batch can be joined. Once a batch is dispatched, a new call starts a new batch. This avoids joining a read that started before another connection committed a write (decided by the spec author).
- Each ID in a pending batch has one shared promise. This is the in-flight dedup.
- A failed batch rejects every promise in it. Failures are never remembered.
- Outside a scope, an ID's entry is dropped when its batch dispatches. The next call reads fresh.
- Inside a scope, settled results stay remembered until the scope ends or a write clears them.
- The loader exposes `clear(id)` and `clearAll()` for write methods.

### Scopes

- `HozonDB.withScope(fn)` opens a scope. `fn` receives a `StoreProvider` whose `getStore` returns store instances with their own memory. The memory is dropped when `fn` settles.
- A transaction is a scope. Its per-transaction store instances already exist in `txStoreAPIs`. They remember results for the transaction's lifetime.
- A scope sees its own writes. Writes from outside the scope can be stale inside it. This is acceptable for a request.
- `withScope` is an optional `StoreProvider` member, like `withSavepoint`. This keeps existing implementers and mocks valid (decided by the spec author).
- `withScope` called on a transaction or scope provider runs `fn` inline, like nested `withTransaction`.
- A scope provider behaves like `HozonDB` for the other members: `onCommit` runs immediately, `onRollback` is a no-op, and there is no `withSavepoint` (decided by the spec author).
- A scope store instance used after `fn` settles keeps working without memory. It batches but remembers nothing (decided by the spec author).
- `withTransaction` called on a scope provider opens a transaction with its own memory. After that transaction commits, the outer scope's memory is cleared entirely.
- A savepoint rollback clears the memory of every store instance in the transaction. Writes rolled back must not stay remembered.

### Writes

- Every write method that can change a batched entity clears the affected IDs, or calls `clearAll()` when the affected IDs are unknown.
- A write dispatches any pending batch for that store before it executes. This keeps program order: a read started before a write never observes the write.

### First adopter: `store-blob`

- Add `getEntries(ids, options?)` and route `getEntry` through the loader.
- Clear on every blob mutation: `insertEntry`, `setPinned`, `deleteEntry`, `beginTransfer`, `recordTransferChunk`, `finalizeTransfer`, `promoteEntry`, `resetTransfer`, `fillContentType`, `touchTransfer`.
- `getTransfer` stays unbatched. A batched form would load every present chunk index for up to 500 blobs, an unbounded result (decided by the spec author).
- `packages/blob` keeps calling `getEntry` as it does now. Its repeated reads of the same ID inside one operation benefit once the caller runs inside a scope or a transaction.
- `packages/blob` re-reads state after taking `BlobLock` to get a fresh view, for example in `prune.ts` and `write.ts`. Those re-reads must not return remembered values. Clear the blob store's memory when `BlobLock` is acquired (decided by the spec author).

## Constraints

- No statement binds more than 500 parameters.
- `StoreDefinition.createAPI(db, adapter)` today receives no scope information. The builder must give store instances a way to know whether they belong to a scope, and to be cleared on savepoint rollback.
- Drivers: Expo (async, mutex-serialised), node-sqlite (sync), sqlocal (Web Worker messages), postgres (network). Tick scheduling must work in Node, React Native, and browsers.
- Conventions follow the `kigu:conventions` skill: `type` over `interface`, `Array<T>`, `#field` privacy, `ID` casing.

## Left to the builder

- Exact names: `createBatchLoader`, `withScope`, option names, and the `BatchLimitError` shape.
- How scope information reaches `createAPI`, for example an optional third context argument.
- The tick scheduling mechanism, within the cross-runtime constraint.
- Whether the loader lives in `db.ts` or in its own module.
- Test design. A test must show N concurrent `getEntry` calls produce one query, and that a call after settle outside a scope reads fresh.
- Reference documentation updates in `docs/reference/db.md`, `docs/reference/stores.md`, and `docs/reference/stores/blob.md`.
