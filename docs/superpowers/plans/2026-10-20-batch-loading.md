# Batch Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-ID store reads such as `getEntry(id)` batch same-tick calls into one `IN (...)` query, and remember results only inside an explicit scope or a transaction.

**Architecture:** `@hozon/db` gains batch primitives (`assertBatchSize`, `iterateBatches`, `BatchLimitError`), a `createBatchLoader` helper, and scope wiring. `HozonDB` passes a `StoreContext` as a third `createAPI` argument. Stores create loaders through it, so the DB owns every loader and can flush and clear them at scope, savepoint and transaction boundaries. `store-blob` is the first adopter.

**Tech Stack:** TypeScript, Kysely, vitest, `@hozon/node-sqlite` for tests.

**Spec:** `docs/superpowers/specs/2026-10-20-batch-loading-design.md`

## Global Constraints

- No statement binds more than 500 parameters.
- Store methods never call `.transaction()` directly. Use `withStoreTransaction`.
- Conventions follow the `kigu:conventions` skill: `type` over `interface`, `Array<T>`, `#field` privacy, `ID` casing, terse comments, British spelling in docs.
- Use pnpm only. Run scripts as `rtk proxy pnpm run <script>` or call tools directly, because an `rtk` shim rewrites `pnpm run`.
- Every requested ID is a key in a batch read result. `null` means not found.
- Outside a scope, no result is remembered past its batch dispatch.
- `iterateBatches` is implemented directly. Its `signal` semantics mirror `prefetchOrdered`. No `@sozai/async` dependency is needed.

## Review Focus

1. Duplicate IDs in one `Promise.all` must produce one key in the batch and resolve every caller with the same value.
2. A failed batch must reject every caller, leave no unhandled rejection, and never be remembered.
3. More concurrent `load` calls than `maxBatchSize` must split into several batches, and all callers resolve.
4. A `load` still pending when a savepoint rolls back or a transaction ends must settle with a value, not a "transaction finished" error.
5. A scoped store instance used after its scope ends must keep working and remember nothing.

---

### Task 1: Batch primitives

**Files:**
- Create: `packages/db/src/batch.ts`
- Modify: `packages/db/src/errors.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/batch.test.ts`

**Interfaces:**
- Produces:
  - `class BatchLimitError extends Error` with `constructor(size: number, limit: number)`, `name = 'BatchLimitError'`, message `` `Batch of ${size} keys exceeds limit ${limit}` ``.
  - `assertBatchSize(size: number, max: number, batchLimit?: number): void`. Throws `RangeError` when `batchLimit` is given and is not a positive integer or exceeds `max`. Throws `BatchLimitError` when `size` exceeds `batchLimit ?? max`.
  - `type BatchReadOptions = { batchLimit?: number }`.
  - `type IterateBatchesOptions = { batchSize: number; signal?: AbortSignal }`.
  - `iterateBatches<TKey, TValue>(keys: Iterable<TKey>, load: (chunk: Array<TKey>) => Promise<Map<TKey, TValue | null>>, options: IterateBatchesOptions): AsyncGenerator<{ keys: Array<TKey>; results: Map<TKey, TValue | null> }>`.

- [ ] **Step 1: Write the failing tests**

```ts
test('assertBatchSize accepts sizes within the limit', () => {
  expect(() => assertBatchSize(500, 500)).not.toThrow()
  expect(() => assertBatchSize(10, 500, 10)).not.toThrow()
})
test('assertBatchSize throws BatchLimitError above the effective limit', () => {
  expect(() => assertBatchSize(501, 500)).toThrow(BatchLimitError)
  expect(() => assertBatchSize(11, 500, 10)).toThrow('Batch of 11 keys exceeds limit 10')
})
test('assertBatchSize rejects an invalid batchLimit', () => {
  for (const limit of [0, -1, 1.5, 501]) {
    expect(() => assertBatchSize(1, 500, limit)).toThrow(RangeError)
  }
})
test('iterateBatches dedupes, chunks in order and calls load once per chunk', async () => {
  const calls: Array<Array<string>> = []
  const load = async (chunk: Array<string>) => {
    calls.push(chunk)
    return new Map(chunk.map((k) => [k, k.toUpperCase()]))
  }
  const seen = []
  for await (const batch of iterateBatches(['a', 'b', 'a', 'c', 'd', 'e'], load, { batchSize: 2 })) {
    seen.push(batch)
  }
  expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  expect(seen[0]).toEqual({ keys: ['a', 'b'], results: new Map([['a', 'A'], ['b', 'B']]) })
})
test('iterateBatches yields nothing for empty input', async () => { /* no load call */ })
test('iterateBatches stops and throws signal.reason when aborted between chunks', async () => {
  // abort after first yield; next iteration rejects with the reason; load called once
})
test('iterateBatches rejects an invalid batchSize with RangeError', async () => { /* 0, 1.5 */ })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm exec vitest run test/batch.test.ts`
Expected: FAIL, module `../src/batch.js` not found.

- [ ] **Step 3: Implement `BatchLimitError` in `errors.ts`, and `assertBatchSize`, `iterateBatches` in `batch.ts`**

`iterateBatches` loops chunks sequentially. It calls `signal?.throwIfAborted()` before each chunk. Export all from `index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/db && pnpm exec vitest run test/batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/batch.ts packages/db/src/errors.ts packages/db/src/index.ts packages/db/test/batch.test.ts
git commit -m "feat(db): add batch read primitives"
```

---

### Task 2: Batch loader

**Files:**
- Create: `packages/db/src/batch-loader.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/batch-loader.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces:
  - `type BatchLoaderParams<TKey, TValue> = { load: (keys: Array<TKey>) => Promise<Map<TKey, TValue | null>>; maxBatchSize: number }`
  - `type BatchLoader<TKey, TValue> = { load(key: TKey): Promise<TValue | null>; clear(key: TKey): void; clearAll(): void; dispatch(): void }`
  - `createBatchLoader<TKey, TValue>(params: BatchLoaderParams<TKey, TValue> & { remember: () => boolean }): BatchLoader<TKey, TValue>`. `remember` is read at settle time. That lets a scope switch a loader to batch-only when it ends.

Behaviour the tests pin:
- Same-tick `load` calls join one pending batch. Dispatch is scheduled after the microtask queue drains: `setImmediate` when defined, else `setTimeout(fn, 0)`.
- `dispatch()` sends the pending batch now, split into chunks of `maxBatchSize`. After dispatch, new calls start a new pending batch.
- Each key in a pending batch shares one promise.
- A key absent from the returned `Map` resolves `null`.
- Each key has a generation. `clear(key)` and `clearAll()` bump it and drop remembered values. A result is remembered only when `remember()` is true and the key's generation is unchanged since dispatch.
- A rejected chunk rejects every caller in that chunk. Nothing is remembered.

- [ ] **Step 1: Write the failing tests**

```ts
test('merges same-tick loads into one call', async () => {
  // Promise.all(['a','b','c'].map(loader.load)) → load called once with ['a','b','c']
})
test('dedupes a key requested twice in one tick', async () => {
  // load('a'), load('a') → keys ['a'], both resolve the same value
})
test('collects loads made after one prior await in the same tick', async () => {
  // Promise.all(ids.map(async (id) => { await Promise.resolve(); return loader.load(id) })) → one call
})
test('splits a batch above maxBatchSize', async () => {
  // maxBatchSize 2, 5 keys → 3 calls, every chunk length ≤ 2, all resolve
})
test('resolves null for a key missing from the result map', async () => {})
test('does not remember when remember() is false', async () => {
  // await load('a'); await load('a') → 2 calls
})
test('remembers when remember() is true until clear', async () => {
  // await load('a') twice → 1 call; clear('a'); load('a') → 2 calls; clearAll same
})
test('a new load after dispatch does not join the in-flight batch', async () => {
  // load('a'); dispatch(); load('a') before first settles → 2 calls
})
test('a late superseded result is not remembered', async () => {
  // remember true; deferred load fn. load('x') dispatch (A); clear('x'); load('x') dispatch (B)
  // resolve B with 'new', then A with 'old'; load('x') → 'new' and no third call
})
test('a failed batch rejects every caller and is not remembered', async () => {
  // remember true; first call rejects; both callers reject; next load calls again
  // no unhandled rejection (track process 'unhandledRejection')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm exec vitest run test/batch-loader.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createBatchLoader` in `batch-loader.ts` and export it with its types**

State: a `Map<TKey, Deferred>` for the pending batch, a remembered `Map<TKey, TValue | null>`, a generation `Map<TKey, number>` plus a global generation for `clearAll`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/db && pnpm exec vitest run test/batch-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/batch-loader.ts packages/db/src/index.ts packages/db/test/batch-loader.test.ts
git commit -m "feat(db): add batch loader"
```

---

### Task 3: Scopes and store context in `HozonDB`

**Files:**
- Create: `packages/db/src/loader-registry.ts`
- Modify: `packages/db/src/db.ts`, `packages/db/src/index.ts`, `docs/reference/db.md`
- Test: `packages/db/test/batch-scope.test.ts`

**Interfaces:**
- Consumes: `createBatchLoader`, `BatchLoader`, `BatchLoaderParams` from Task 2.
- Produces:
  - `type StoreContext = { createLoader<TKey, TValue>(params: BatchLoaderParams<TKey, TValue>): BatchLoader<TKey, TValue> }`
  - `StoreDefinition.createAPI: (db: Kysely<Tables>, adapter: Adapter, context: StoreContext) => API`. Existing two-argument stores stay valid.
  - `StoreProvider.withScope?<NestedStores extends Record<string, unknown>, R>(fn: (scope: StoreProvider<NestedStores>) => Promise<R>): Promise<R>`
  - `HozonDB.withScope` with the same signature.
  - Internal `LoaderRegistry` (not exported): `createLoader`, `dispatchAll()`, `clearAll()`, `close()`. `close()` clears and makes `remember()` return false.

Wiring decisions:
- Base `HozonDB` store instances use a registry whose loaders never remember.
- `withScope` creates a remembering registry and its own store-instance map. The provider's `onCommit` runs immediately, `onRollback` is a no-op, and it has no `withSavepoint`. `withScope` on it runs inline. When `fn` settles, call `registry.close()`.
- `withScope` on a transaction provider runs inline.
- Each `withTransaction` creates one remembering registry, shared by its savepoint providers, as `txStoreAPIs` is. Call `close()` once the transaction settles.
- Savepoint creation, release and rollback each call `dispatchAll()` before the SQL statement. Rollback then calls `clearAll()` before the savepoint rollback hooks run.
- The transaction callback wrapper calls `dispatchAll()` after `fn` resolves or throws, before Kysely commits or rolls back.
- `withTransaction` on a scope provider opens a transaction. After commit, the outer scope's `registry.clearAll()` runs before commit hooks. Add a private `#withTransaction(fn, beforeHooks?)` and keep the public signature.

- [ ] **Step 1: Write the failing tests**

Register a test store over a `kv(key text primary key, value text)` table. Its `createAPI(db, adapter, context)` exposes `get(key)` through `context.createLoader` with `maxBatchSize: 500`, and `set(key, value)` which calls `loader.dispatch()`, upserts, then `loader.clear(key)`. Count queries with `vi.spyOn(adapter.database, 'prepare')`, filtered to SQL selecting from `kv`.

```ts
test('base provider batches concurrent gets into one query', async () => {})
test('base provider reads fresh after a batch settles', async () => {
  // await get('a'); await get('a') → 2 queries
})
test('a scope remembers results until a write clears them', async () => {
  // withScope: get twice → 1 query; set('a','b'); get → 'b' with a second query
})
test('a scoped store used after the scope ends remembers nothing', async () => {
  // capture store in withScope; after it returns, get twice → 2 queries, values correct
})
test('a transaction remembers results', async () => {})
test('savepoint rollback drops values written inside it', async () => {
  // tx: get('a') → 'v1'; withSavepoint: set('a','v2'); get → 'v2'; throw
  // after rollback get('a') → 'v1'
})
test('a load pending at savepoint rollback settles with a value', async () => {
  // in withSavepoint: const p = store.get('a'); throw; after: await p resolves 'v1'
})
test('a load pending at transaction end settles with a value', async () => {
  // in withTransaction: start get without awaiting, return; awaiting it later resolves
})
test('a transaction committed from a scope clears the scope before commit hooks', async () => {
  // scope: get('a') → 'v1' remembered
  // scope.withTransaction(tx): tx store set('a','v2'); tx.onCommit(() => { p = scopedStore.get('a') })
  // await p → 'v2'
})
test('withScope on a transaction provider runs inline with the transaction stores', async () => {})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/db && pnpm exec vitest run test/batch-scope.test.ts`
Expected: FAIL, `withScope` is not a function.

- [ ] **Step 3: Implement `LoaderRegistry` and the wiring above in `db.ts`. Export `StoreContext`.**

- [ ] **Step 4: Run the full db suite**

Run: `cd packages/db && rtk proxy pnpm run test`
Expected: PASS, including the existing `transaction.test.ts`.

- [ ] **Step 5: Document in `docs/reference/db.md`**

Add the new exports to the export list. Add `StoreContext`, the three-argument `createAPI`, and `withScope` to the type block. Add a "Batch loading and scopes" section covering:
- same-tick batching
- remembered results only inside scopes and transactions
- the batch read contract (`assertBatchSize`, every key present, `null` = missing)
- `iterateBatches`
- write clearing, and that the batch read is the fresh-read path
- the postgres pool ordering limit
- sequential `await` loops do not batch

- [ ] **Step 6: Commit**

```bash
git add packages/db docs/reference/db.md
git commit -m "feat(db): add load scopes and store context"
```

---

### Task 4: `store-blob` batched entry reads

**Files:**
- Modify: `packages/store-blob/src/api.ts`, `packages/store-blob/src/types.ts`, `docs/reference/stores/blob.md`, `docs/reference/stores.md`
- Test: `packages/store-blob/test/store-blob.test.ts`

**Interfaces:**
- Consumes: `StoreContext`, `assertBatchSize`, `BatchReadOptions` from Tasks 1 and 3.
- Produces on `BlobStoreAPI`: `getEntries(blobIDs: Array<string>, options?: BatchReadOptions): Promise<Map<string, BlobEntry | null>>`. `getEntry` keeps its signature.

Decisions:
- `ENTRY_BATCH_MAX = 500`, because the query binds only the IDs.
- `getEntries` dedupes the IDs, calls `assertBatchSize`, runs one `where('blob_id', 'in', ...)` query, maps rows with the existing row mapper, and fills `null` for missing IDs. Empty input returns an empty `Map` without a query. It never touches the loader.
- `getEntry(id)` returns `entries.load(id)`, where `entries = context.createLoader({ load: (ids) => getEntries(ids), maxBatchSize: ENTRY_BATCH_MAX })`.
- Each mutation calls `entries.dispatch()` first and `entries.clear(blobID)` in a `finally`. Mutations: `insertEntry`, `setPinned`, `deleteEntry`, `beginTransfer`, `recordTransferChunk`, `finalizeTransfer`, `promoteEntry`, `resetTransfer`, `fillContentType`, `touchTransfer`. Use one local wrapper, not ten copies.
- `getTransfer` is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test('getEntries returns every requested key with null for missing', async () => {
  // insert 'a'; getEntries(['a','zz','a']) → Map size 2, a → entry, zz → null
})
test('getEntries throws BatchLimitError above 500 unique IDs or above batchLimit', async () => {})
test('getEntries returns an empty map for empty input', async () => {})
test('concurrent getEntry calls run one query', async () => {
  // spy adapter.database.prepare, count SQL selecting from blob_entries; 3 concurrent → 1
})
test('getEntry inside a scope sees setPinned', async () => {
  // withScope: getEntry('a') pinned false; setPinned('a', true); getEntry('a') pinned true
})
test('getEntries bypasses remembered values inside a scope', async () => {
  // withScope: getEntry('a') remembered; base store setPinned('a', true)
  // scoped getEntry('a') still pinned false; scoped getEntries(['a']) → pinned true
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/store-blob && pnpm exec vitest run test/store-blob.test.ts`
Expected: FAIL, `getEntries` is not a function.

- [ ] **Step 3: Implement as decided. Accept `context` as the third `createAPI` argument in `api.ts` and `definition.ts`.**

- [ ] **Step 4: Run the package suite**

Run: `cd packages/store-blob && rtk proxy pnpm run test`
Expected: PASS.

- [ ] **Step 5: Document**

In `docs/reference/stores/blob.md`, add `getEntries` and its contract. In `docs/reference/stores.md`, add a line linking to db.md "Batch loading and scopes", noting that `getEntry` batches.

- [ ] **Step 6: Commit**

```bash
git add packages/store-blob docs/reference/stores.md docs/reference/stores/blob.md
git commit -m "feat(store-blob): batch entry reads"
```

---

### Task 5: Fresh entry reads under `BlobLock`, and release intents

**Files:**
- Modify: `packages/blob/src/write.ts:183,191,218`, `packages/blob/src/transfer.ts:192,247,363`
- Create: `packages/blob/src/fresh.ts`
- Test: `packages/blob/test/fresh.test.ts`

**Interfaces:**
- Consumes: `BlobStoreAPI.getEntries` from Task 4.
- Produces: `getFreshEntry(store: BlobStoreAPI, blobID: string): Promise<BlobEntry | null>`, internal to `@hozon/blob` and not exported from its index.

Decisions:
- Replace `getEntry` with `getFreshEntry` only inside `ctx.lock.withLock` callbacks, at the six lines listed. `transfer.ts:173` is outside the lock and stays.
- `prune.ts` uses `getTransfer`, which is already fresh, so it is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
test('getFreshEntry ignores remembered values in a scope', async () => {
  // withScope: scoped store getEntry('a') remembered; base store setPinned('a', true)
  // getFreshEntry(scopedStore, 'a') → pinned true
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/blob && pnpm exec vitest run test/fresh.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `getFreshEntry` and swap the six call sites**

- [ ] **Step 4: Run the package and integration suites**

Run: `cd packages/blob && rtk proxy pnpm run test`, then `rtk proxy pnpm run test:integration` at the repo root.
Expected: PASS.

- [ ] **Step 5: Add release intents**

Follow the `kigu:releasing` skill. Record intents for:
- `@hozon/db`: minor. Batch loader, scopes, store context, batch primitives.
- `@hozon/store-blob`: minor. `getEntries` and batched `getEntry`.
- `@hozon/blob`: patch. Fresh entry reads under the blob lock.

- [ ] **Step 6: Commit**

```bash
git add packages/blob .changeset
git commit -m "fix(blob): read entries fresh under the blob lock"
```
