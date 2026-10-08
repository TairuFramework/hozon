# Blob ID and Blob Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Stage:** planning
**Mode:** (chosen at handoff)

**Goal:** Add generic blob ID derivation (`@hozon/blob-id`) and storage orchestration (`@hozon/blob`) on top of the existing blob backend and store, with the backend and store extensions they need.

**Architecture:** `@hozon/blob-id` owns codecs and single-pass hashing. `@hozon/blob-backend` gains staging reads, staging listing and the `BlobLock` contract; `@hozon/blob-node-fs` implements them plus a file lock. `@hozon/store-blob` gains MIME metadata, transfer sessions, pagination and atomic promote/reset. `@hozon/blob` composes these into `createBlobService`: verified writes, reads, deletes, peer transfer, and staging maintenance, all serialized per blob ID.

**Tech Stack:** TypeScript (ESM, Node >= 24), Web Streams, Kysely via `@hozon/db`, `@noble/hashes` (BLAKE3), `@sozai/lock`, vitest, swc.

**Spec:** `/Users/paul/dev/yulsi/teikyo/docs/superpowers/specs/2026-10-08-blob-design.md` (Part 1). Read it before starting; this plan does not restate its rationale.

## Global Constraints

- pnpm only. Repo conventions per the `kigu:conventions` skill. Run scripts as `rtk proxy pnpm run <script>` or invoke tools directly.
- Nothing kubun-specific: no kubun ID format, refs, events or GraphQL.
- New packages copy the layout, scripts, `tsconfig.json`/`tsconfig.test.json` and `publishConfig` of `packages/store-blob`. Dependencies use `catalog:`; add `@noble/hashes: ^2.4.0` and `@sozai/lock` (current published version) to the catalog in `pnpm-workspace.yaml`.
- `@hozon/blob-id`, `@hozon/blob-backend`, `@hozon/blob` must stay portable (no `node:` imports in `src`). Only `@hozon/blob-node-fs` may use Node APIs.
- Default ID: `varint(contentLength) || BLAKE3-256 digest`, lowercase RFC 4648 base32, no padding. Codec IDs use only `[a-z0-9_-]`.
- Service defaults: `chunkSize = 1 MiB` (1048576), `maxBlobSize = 1 GiB`, `maxChunkSize = 16 MiB`, `minChunkSize = 1 KiB`.
- Lock order is always blob lock, then store transaction. Locks are non-reentrant.
- Bytes are committed before rows; nothing from a transfer is committed before whole-blob verification.
- Every public service method canonicalizes its ID argument first.

## Review Focus

- **Zero-length blob.** Writes, reads (no range), manifest of zero chunks, and transfer with `contentLength: 0` must all work. Tests in Tasks 1, 6, 8.
- **Final chunk shorter than `chunkSize`, and content length an exact multiple of `chunkSize`.** Off-by-one in chunk count or last-chunk length. Tests in Tasks 1 and 8.
- **Uppercase or otherwise non-canonical ID input** to every service method resolves to the same blob. Test in Task 7.
- **Stream that errors mid-write** (not abort, a source error) leaves no staging and no row. Test in Task 6.
- **Second write of the same bytes with a different `contentType`** keeps the first metadata unless it was null. Test in Task 6.

---

### Task 1: `@hozon/blob-id` package

**Files:**
- Create: `packages/blob-id/package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`
- Create: `packages/blob-id/src/index.ts`, `src/types.ts`, `src/varint.ts`, `src/base32.ts`, `src/blake3.ts`, `src/hash-stream.ts`, `src/errors.ts`, `src/conformance.ts`
- Test: `packages/blob-id/test/varint.test.ts`, `test/base32.test.ts`, `test/blake3.test.ts`, `test/hash-stream.test.ts`

**Interfaces:**
- Produces:
  - `type BlobIDInfo = { digest: Uint8Array; contentLength: number; contentType?: string }`
  - `type BlobHasher = { update(bytes: Uint8Array): void; digest(): Uint8Array }`
  - `type BlobIDCodec = { digestLength: number; createHasher(): BlobHasher; encode(info: BlobIDInfo): string; decode(id: string): BlobIDInfo; canonicalize(id: string): string }`
  - `class InvalidBlobIDError extends Error` (message `Invalid blob ID: <json id>`)
  - `const blake3Codec: BlobIDCodec` (`digestLength: 32`)
  - `type HashResult = { digest: Uint8Array; contentLength: number; chunks: Array<Uint8Array> }`
  - `function hashStream(codec: BlobIDCodec, chunkSize: number): { transform: TransformStream<Uint8Array, Uint8Array>; result: Promise<HashResult> }`
  - `function checkCodecConformance(codec: BlobIDCodec, samples: Array<BlobIDInfo>): void` (throws `Error` describing the first violation), exported from `@hozon/blob-id/conformance` (second `exports` entry)
  - `const BLOB_ID_ALPHABET = /^[a-z0-9_-]+$/`

- [ ] **Step 1: Scaffold the package** from `packages/store-blob` (name `@hozon/blob-id`, description "Pluggable content-addressed blob IDs for Hozon", dependency `@noble/hashes: catalog:`, `exports` `"."` and `"./conformance"`). Run `pnpm install`.

- [ ] **Step 2: Write failing tests**

`varint.test.ts`: unsigned LEB128 round trip for `0, 1, 127, 128, 16383, 16384, 2**32, Number.MAX_SAFE_INTEGER`; `encodeVarint(300)` equals `[0xac, 0x02]`; `decodeVarint` of a truncated buffer (`[0x80]`) throws; negative or non-integer input to `encodeVarint` throws.

`base32.test.ts`: RFC 4648 vectors lowercased without padding: `''`→`''`, `'f'`→`'my'`, `'fo'`→`'mzxq'`, `'foo'`→`'mzxw6'`, `'foobar'`→`'mzxw6ytboi'`; decode accepts only `[a-z2-7]`; decode of a string with non-zero trailing bits throws.

`blake3.test.ts`:
```ts
test('encodes empty content', () => {
  const hasher = blake3Codec.createHasher()
  const id = blake3Codec.encode({ digest: hasher.digest(), contentLength: 0 })
  // varint(0) = 0x00, then BLAKE3("") = af1349b9...
  expect(id).toBe(base32Encode(concat([0x00], hexToBytes('af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'))))
  expect(blake3Codec.decode(id)).toEqual({ digest: hexToBytes('af13…3262'), contentLength: 0 })
})
test('ignores contentType', ...)        // encode({...,contentType:'text/plain'}) === encode without it
test('canonicalize lowercases', ...)    // canonicalize(id.toUpperCase()) === id
test('rejects invalid IDs', ...)        // decode/canonicalize throw InvalidBlobIDError for '', 'x', '!!', digest of 31 bytes, trailing garbage
test('passes conformance', () => checkCodecConformance(blake3Codec, samples))
```
plus a conformance negative test: a codec whose `encode` returns uppercase makes `checkCodecConformance` throw; one returning `'a..b'` throws.

`hash-stream.test.ts`, with `chunkSize = 4`, piping bytes through `transform` and awaiting `result`:
- empty input → `contentLength 0`, `chunks: []`, digest = BLAKE3 of empty
- 8 bytes (exact multiple) → 2 chunks, each equal to BLAKE3 of its 4 bytes
- 10 bytes in input pieces of sizes `[3, 5, 2]` → 3 chunks, last covers 2 bytes; whole digest = BLAKE3 of all 10
- output bytes equal input bytes
- an erroring source rejects `result`

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/blob-id && pnpm exec vitest run`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**
- `varint.ts`: `encodeVarint(n: number): Uint8Array`, `decodeVarint(bytes: Uint8Array, offset = 0): { value: number; length: number }` (LEB128 over safe integers, using arithmetic not bit shifts above 2^31).
- `base32.ts`: `base32Encode(bytes: Uint8Array): string`, `base32Decode(text: string): Uint8Array` (alphabet `abcdefghijklmnopqrstuvwxyz234567`).
- `blake3.ts`: hasher from `@noble/hashes/blake3.js` `blake3.create()`. `decode` requires the decoded bytes to be exactly `varint + 32` bytes. `canonicalize` = lowercase, then decode, then re-encode, and compare.
- `hash-stream.ts`: a `TransformStream` that feeds a whole hasher and a current-chunk hasher, splitting input pieces at chunk boundaries; memory bounded to the incoming piece. `result` resolves in `flush`, rejects if the transform errors or is cancelled.
- `conformance.ts`: for each sample, `encode` matches `BLOB_ID_ALPHABET`, contains no `..`, `canonicalize(id) === id`, `canonicalize(id.toUpperCase())` either equals `id` or throws `InvalidBlobIDError`, and `decode(id)` preserves `digest` and `contentLength`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/blob-id && rtk proxy pnpm run test`
Expected: types and unit tests PASS.

- [ ] **Step 6: Write the README** (codec contract, default format, KAT for the empty blob, conformance usage) and commit.

```bash
git add packages/blob-id pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(blob-id): add pluggable blob ID codecs with BLAKE3 default"
```

### Task 2: Backend staging reads, staging listing and the lock contract

**Files:**
- Modify: `packages/blob-backend/src/backend.ts`, `src/memory.ts`, `src/index.ts`
- Create: `packages/blob-backend/src/lock.ts`
- Test: `packages/blob-backend/test/memory.test.ts`, `test/lock.test.ts`

**Interfaces:**
- Produces (added to `BlobBackend`):
  - `createStagingReadStream(stagingID: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>` (required)
  - `listStaging?(): AsyncIterable<{ stagingID: string; modifiedAt: Date }>`
  - Doc comment on `commit`: once it returns, the staging ID is consumed; later writes to that ID start an unrelated area.
- Produces (new `lock.ts`, exported):
  - `type BlobLock = { withLock<T>(id: string, fn: () => Promise<T>): Promise<T> }`
  - `class BlobLockTimeoutError extends Error`
  - `function createMemoryBlobLock(): BlobLock`

- [ ] **Step 1: Write failing tests**
- memory: bytes written with `createStaging` and with out-of-order `writeChunk` read back through `createStagingReadStream`, with and without a range; reading an unknown staging ID rejects; `listStaging()` yields each live staging area with `modifiedAt` updated on every write; after `commit` and `abortStaging` the ID is no longer listed; writing to a committed staging ID then reading the content key returns the original bytes.
- lock: two `withLock('a', …)` calls run sequentially (record start/end order); `withLock('a')` and `withLock('b')` overlap; a rejection in `fn` releases the lock (a following `withLock('a')` runs); return values pass through.

- [ ] **Step 2: Run tests to verify they fail** — `cd packages/blob-backend && pnpm exec vitest run`, expected FAIL.

- [ ] **Step 3: Implement.** Memory staging assembly reuses the existing segment-flattening used by `commit`; track `modifiedAt` per staging ID. `createMemoryBlobLock` is a keyed promise chain (`Map<string, Promise<void>>`), deleting the key when its tail settles.

- [ ] **Step 4: Run tests to verify they pass** — `rtk proxy pnpm run test` in the package, expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(blob-backend): add staging reads, staging listing and BlobLock"`

### Task 3: FS backend staging reads, listing and file lock

**Files:**
- Modify: `packages/blob-node-fs/src/fs.ts`, `src/index.ts`, `package.json` (add `@sozai/lock: catalog:`)
- Create: `packages/blob-node-fs/src/lock.ts`
- Test: `packages/blob-node-fs/test/staging.test.ts`, `test/lock.test.ts`, `test/fixtures/lock-child.ts`

**Interfaces:**
- Consumes: `BlobBackend`, `BlobLock`, `BlobLockTimeoutError` from Task 2.
- Produces: `FSBlobBackend.createStagingReadStream`, `FSBlobBackend.listStaging` (staging file `mtime`); `function createFileBlobLock(directory: string, options?: { acquireTimeoutMs?: number }): BlobLock`.

- [ ] **Step 1: Write failing tests**
- staging: same assertions as Task 2's memory staging tests, run against `FSBlobBackend` in a `mkdtemp` directory; `listStaging` on a root with no staging directory yields nothing; after `commit`, the staging file is gone (existing behaviour, asserted again).
- lock: two `withLock('id')` in one process serialize; a child process (spawned with `node --experimental-strip-types test/fixtures/lock-child.ts <dir> <id> <holdMs>`) holding the lock blocks the parent until released; with `acquireTimeoutMs: 50` while the child holds it, the parent rejects with `BlobLockTimeoutError`; the lock file name for an ID is `<directory>/<id>.lock` and IDs failing `assertSafeName` are rejected.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.

- [ ] **Step 3: Implement.** `createFileBlobLock` wraps `withFileLock(join(directory, `${id}.lock`), fn, { timeoutMs })` from `@sozai/lock`; translate its `TimeoutInterruption` into `BlobLockTimeoutError`. Document in the README: local filesystem only, non-reentrant, stale-lock reaping gap from `@sozai/lock`.

- [ ] **Step 4: Run tests to verify they pass** — expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(blob-node-fs): add staging reads, staging listing and file lock"`

### Task 4: Store schema: MIME, transfer sessions, backfill

**Files:**
- Modify: `packages/store-blob/src/migrations.ts`, `src/tables.ts`, `src/types.ts`, `src/api.ts`, `src/index.ts`
- Test: `packages/store-blob/test/store-blob.test.ts`, create `test/migration.test.ts`

**Interfaces:**
- Produces:
  - `BlobEntryInput.contentType?: string | null`, `BlobEntry.contentType: string | null`
  - `BlobTransferSessionTable = { blob_id: string; staging_id: string; updated_at: number }` as `blob_transfer_sessions`
  - `type BlobTransfer = { stagingID: string; updatedAt: number; presentChunks: Array<number> }`
  - `beginTransfer(blobID: string, chunkSize: number, chunks: Array<BlobChunkInput>, stagingID: string): Promise<void>` (breaking: new required `stagingID`; creates or replaces the session row)
  - `recordTransferChunk` also sets `updated_at = Date.now()` on the session
  - `getTransfer(blobID): Promise<BlobTransfer | null>`, `getTransferByStagingID(stagingID): Promise<{ blobID: string; updatedAt: number } | null>`, `touchTransfer(blobID): Promise<void>`
  - `finalizeTransfer` and `deleteEntry` also delete the session row

- [ ] **Step 1: Write failing tests**
- `contentType` round-trips through `insertEntry`/`getEntry`, defaults to `null`.
- `beginTransfer(..., 'stg-1')` then `getTransfer` → `{ stagingID: 'stg-1', presentChunks: [] }` (session exists with zero chunks); `recordTransferChunk` advances `updatedAt` (use `vi.setSystemTime`); `getTransferByStagingID('stg-1')` returns the blob ID; `beginTransfer` again with `'stg-2'` replaces the session; `finalizeTransfer` and `deleteEntry` remove it.
- migration: create a DB at migration `0-init` only (run the `0-init` migration's `up` directly through `db.schema` on a raw Kysely, as the existing schema-version tests do), insert a `partial` entry with manifest and transfer rows, then register the store (runs `1-sessions`): entry state is `remote-only`, `getChunkDigests` is empty, `getPresentChunkIndexes` is empty; a `local` entry is untouched.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.

- [ ] **Step 3: Implement migration `1-sessions`**: add nullable `content_type` (`ctx.types.text`) to `blob_entries`; create `blob_transfer_sessions` (`blob_id` text PK with FK to `blob_entries` `ON DELETE CASCADE`, constraint names prefixed with `ctx.tablePrefix` like `0-init`; `staging_id` text not null unique; `updated_at` `ctx.types.bigint` not null); backfill: delete `blob_transfers` and `blob_chunks` rows of `partial` entries, then set those entries to `remote-only`. `down` reverses the schema changes (backfill is not reversible; document that).

- [ ] **Step 4: Run tests to verify they pass** — `rtk proxy pnpm run test` in the package, expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(store-blob): add content type and transfer sessions"`

### Task 5: Store operations: list, promote, reset

**Files:**
- Modify: `packages/store-blob/src/api.ts`, `src/types.ts`
- Test: `packages/store-blob/test/store-blob.test.ts`; `tests/integration/test/store-blob.test.ts`

**Interfaces:**
- Produces:
  - `listEntries(params: { limit: number; cursor?: string }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>`; order `(created_at, blob_id)` ascending; cursor is opaque (base64url of JSON `[createdAt, blobID]`); `limit` 1–1000, else throws.
  - `promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>` — one transaction: upsert entry with `state: 'local'` (on conflict update all columns except `blob_id`, `created_at`, `pinned`), delete existing chunks, transfers and session for the ID, insert `chunks`.
  - `resetTransfer(blobID: string): Promise<void>` — one transaction: delete session, transfers and chunks; set state `remote-only`. No-op for unknown IDs.

- [ ] **Step 1: Write failing tests** (unit, then copy the list/promote/reset cases into the integration `describe.each(backends())`):
- `listEntries` over 5 entries with equal `createdAt` and `limit: 2` returns 2, 2, 1 entries ordered by `blob_id`, last `nextCursor: null`; invalid cursor throws; `limit: 0` throws.
- `promoteEntry` on an absent ID inserts a local entry with manifest; on a `partial` entry with a session and present chunks it replaces the manifest (different `chunkSize` allowed), clears transfers and session, keeps `pinned` and `createdAt`; on a `remote-only` stub with `chunkSize: 0` it works.
- `resetTransfer` on a partial entry leaves `remote-only`, no manifest, no session.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.

- [ ] **Step 3: Implement** in `api.ts`, reusing `insertManifest` and `withStoreTransaction`; lock the entry row with `forUpdate()` on Postgres as `beginTransfer` does.

- [ ] **Step 4: Run tests to verify they pass** — package tests, then `cd tests/integration && rtk proxy pnpm run test -- store-blob` (Postgres via testcontainers; Docker required). Expected PASS on both backends.

- [ ] **Step 5: Update `docs/reference/stores/blob.md`** (new column, sessions table, new operations, backfill note) and commit — `git commit -m "feat(store-blob): add listing, atomic promote and transfer reset"`

### Task 6: `@hozon/blob` service: identity, errors, write

**Files:**
- Create: `packages/blob/package.json` (deps `@hozon/blob-id`, `@hozon/blob-backend`, `@hozon/store-blob`, `@hozon/db`; devDeps `@hozon/node-sqlite`, `@hozon/blob-node-fs`), `tsconfig*.json`, `README.md`
- Create: `packages/blob/src/index.ts`, `src/service.ts`, `src/errors.ts`, `src/limits.ts`, `src/write.ts`
- Test: `packages/blob/test/helpers.ts`, `test/write.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces:
  - `type BlobLimits = { maxBlobSize: number; maxChunkSize: number; minChunkSize: number }`
  - `type BlobServiceParams = { db: StoreProvider; backend: BlobBackend; codec?: BlobIDCodec; chunkSize?: number; lock?: BlobLock; limits?: Partial<BlobLimits> }` (the service gets the store via `getBlobStore(db)`; `db.register(blobStoreDefinition)` is the caller's job and is documented)
  - `function createBlobService(params: BlobServiceParams): BlobService` (validates `chunkSize` within limits, throws `Error('Invalid chunkSize')` / `Error('Invalid limits')`)
  - `type WriteOptions = { contentType?: string; encrypted?: boolean; keyID?: string; expectedID?: string; maxSize?: number; signal?: AbortSignal }`
  - `BlobService.write(stream: ReadableStream<Uint8Array>, options?: WriteOptions): Promise<{ entry: BlobEntry; created: boolean }>`
  - `BlobService.writeWith<T>(stream, options: WriteOptions, fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T>): Promise<{ entry: BlobEntry; created: boolean; result: T }>`
  - Errors (all `extends Error`, exported): `BlobNotFoundError`, `BlobTooLargeError`, `BlobIDMismatchError`, `ContentTypeMismatchError`, `ChunkDigestMismatchError`, `ChunkLengthError`, `InvalidManifestError`, `InvalidRangeError`, `BlobWriteAbortedError`; re-export `InvalidBlobIDError` and `BlobLockTimeoutError`.

- [ ] **Step 1: Write failing tests** (`helpers.ts` builds a service on `NodeSQLiteAdapter(':memory:')` + `MemoryBlobBackend`; `write.test.ts` runs its cases for both `MemoryBlobBackend` and `FSBlobBackend` via `describe.each`):
- write 10 bytes → `created: true`, `entry.blobID === blake3Codec.encode(...)`, `contentLength 10`, `state 'local'`, manifest digests equal the `hashStream` chunks; backend `has(id)`.
- zero-length write works and has zero chunks.
- second identical write → `created: false`, same entry, no new staging left (`listStaging` empty).
- second write with `contentType: 'image/png'` when the first had none → stored type becomes `'image/png'`; a third with `'text/plain'` keeps `'image/png'`.
- `maxSize: 4` with 10 bytes → `BlobTooLargeError`, no row, staging empty; also with `limits.maxBlobSize` as the bound.
- `expectedID` of different bytes → `BlobIDMismatchError`, nothing committed; uppercase `expectedID` of the same bytes succeeds.
- MIME-embedding test codec (wraps `blake3Codec`, appends `-` + base32 of the type in `encode`, recovers it in `decode`): `expectedID` carrying `image/png` with no request `contentType` stores `'image/png'`; with `'text/plain'` throws `ContentTypeMismatchError` before the stream is read (assert the source's `pull` was never called).
- `expectedID` decoding to `contentLength` above `maxSize` throws `BlobTooLargeError` without reading.
- source stream that errors after 3 bytes → rejects with that error, no row, staging empty.
- `signal` aborted mid-stream → `BlobWriteAbortedError`; aborted after the stream ends but before commit (service built with a wrapping `BlobLock` whose `withLock` calls `controller.abort()` before invoking `fn`) → `BlobWriteAbortedError` and `backend.has(id)` false.
- write promotes an existing `partial` entry (created via store `insertEntry` + `beginTransfer`) to `local`, discarding its transfer staging area.
- `writeWith`: `fn` receives a tx provider whose `getStore('blob')` sees the new entry; when `fn` throws, the entry row is absent afterwards and the error propagates; concurrent `delete(id)` started while `writeWith` holds the lock completes only after it (assert ordering), on single-connection SQLite without deadlock.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.

- [ ] **Step 3: Implement** `write.ts` following the spec's Write section steps 1–5 exactly. Staging IDs: `w-` + 32 hex chars from `crypto.getRandomValues` (global `crypto`). Track live write staging IDs in a `Set` on the service (used by Task 9). Pump with `stream.pipeThrough(hashStream(...).transform).pipeTo(staging, { signal })` plus a counting step that errors with `BlobTooLargeError` past the limit. Under `lock.withLock(id)`: re-check `signal`, check existing entry, `backend.commit`, then `store.promoteEntry` (for `write`) or `db.withTransaction(async (tx) => { promote via (await tx.getStore('blob')).promoteEntry; return fn(tx, entry) })` (for `writeWith`).

- [ ] **Step 4: Run tests to verify they pass** — `cd packages/blob && rtk proxy pnpm run test`, expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(blob): add blob service with verified writes"`

### Task 7: Service reads and management

**Files:**
- Create: `packages/blob/src/read.ts`, `src/manage.ts`
- Modify: `packages/blob/src/service.ts`
- Test: `packages/blob/test/read.test.ts`, `test/manage.test.ts`

**Interfaces:**
- Produces on `BlobService`:
  - `get(id: string): Promise<BlobEntry | null>`
  - `list(params: { limit: number; cursor?: string }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>`
  - `has(id: string): Promise<boolean>`
  - `getChunkDigests(id: string): Promise<Array<Uint8Array>>`
  - `createReadStream(id: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>`
  - `setPinned(id: string, pinned: boolean): Promise<void>` (throws `BlobNotFoundError` for unknown IDs)
  - `delete(id: string): Promise<boolean>` (`false` when nothing existed)
  - `codec: BlobIDCodec`, `limits: BlobLimits` (read-only, for callers such as HTTP handlers)

- [ ] **Step 1: Write failing tests**
- Each method called with the uppercase form of a stored ID behaves as with the canonical ID; with `'not-an-id'` throws `InvalidBlobIDError`.
- `createReadStream` full and ranged (`{start: 2, end: 5}`); `end >= contentLength` or `start > end` throws `InvalidRangeError`; `remote-only` or `partial` entry throws `BlobNotFoundError`; zero-length blob reads empty.
- `has` false for `partial`.
- `delete` removes row, manifest, session and bytes; returns `false` the second time; a `partial` entry's staging area is aborted.
- concurrent `write` and `delete` of the same bytes (both started together, 20 iterations): afterwards, row present ⇔ bytes present.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.
- [ ] **Step 3: Implement**; `delete` and `setPinned` run under the blob lock.
- [ ] **Step 4: Run tests to verify they pass** — expected PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(blob): add reads, pinning and deletion"`

### Task 8: Service peer transfer

**Files:**
- Create: `packages/blob/src/transfer.ts`
- Modify: `packages/blob/src/service.ts`
- Test: `packages/blob/test/transfer.test.ts`

**Interfaces:**
- Produces on `BlobService`:
  - `type TransferManifest = { contentLength: number; chunkSize: number; chunks: Array<Uint8Array>; contentType?: string; encrypted?: boolean; keyID?: string }`
  - `beginFetch(id: string, manifest: TransferManifest): Promise<void>`
  - `getPresentChunks(id: string): Promise<Array<number>>`
  - `stageChunk(id: string, index: number, bytes: Uint8Array): Promise<void>`
  - `completeFetch(id: string): Promise<BlobEntry>`

- [ ] **Step 1: Write failing tests** (both backends), using a source service that wrote the blob to produce real manifests:
- happy path: chunks staged in reverse order, `completeFetch` → `local`, bytes equal; `getPresentChunks` empty afterwards.
- `beginFetch` on a `local` blob is a no-op; identical manifest twice keeps the same session; a different manifest resets progress.
- invalid manifests → `InvalidManifestError`, nothing recorded: chunk count off by one; digest of 31 bytes; `chunkSize` 512 (below `minChunkSize`) and 32 MiB (above max); `contentLength` not matching `codec.decode(id)`; `contentLength` above `maxBlobSize`; non-integer `chunkSize`; MIME-embedding codec with a conflicting `contentType`.
- zero-length blob: `beginFetch` with `chunks: []`, then `completeFetch` succeeds.
- `stageChunk`: index out of range → `InvalidManifestError`; wrong length (last chunk padded, middle chunk short) → `ChunkLengthError`; wrong digest → `ChunkDigestMismatchError`; none recorded.
- `completeFetch` with a missing chunk throws and leaves the transfer intact.
- whole-blob mismatch: manifest whose chunk digests match tampered bytes but whose ID is of the original → `BlobIDMismatchError`; `backend.has(id)` false; entry `remote-only`; no session.
- resume: after staging 2 of 3 chunks, a new service instance on the same DB and backend returns `[0, 1]` from `getPresentChunks`; if the staging area was aborted out of band, it returns `[]` and the entry is `remote-only`.
- concurrent `stageChunk` and `completeFetch`: `stageChunk` that acquires the lock after completion throws (`BlobNotFoundError` style "no active transfer").

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.
- [ ] **Step 3: Implement** per the spec's Peer transfer section; staging IDs `t-` + 32 hex chars; a transfer's staging area counts as missing when `createStagingReadStream(stagingID, { start: 0, end: 0 })` rejects (skip the check for zero-length blobs).
- [ ] **Step 4: Run tests to verify they pass** — expected PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(blob): add verified resumable peer transfer"`

### Task 9: Staging maintenance, integration and docs

**Files:**
- Create: `packages/blob/src/prune.ts`
- Modify: `packages/blob/src/service.ts`, `packages/blob/README.md`, `docs/reference/blob-backends.md`, `tests/integration/package.json`
- Create: `tests/integration/test/blob-service.test.ts`
- Test: `packages/blob/test/prune.test.ts`

**Interfaces:**
- Produces: `BlobService.pruneStaging(olderThan: Date): Promise<{ removed: number }>`

- [ ] **Step 1: Write failing tests** (`vi.setSystemTime` to age things; FS backend uses `utimes` on staging files):
- old orphan write staging is removed; a write in progress (stream held open) is kept even when `olderThan` is in the future.
- old transfer staging whose session `updatedAt` is also old is aborted and the entry reset to `remote-only`.
- transfer whose staging file is old but whose session was touched recently is kept.
- race: `listStaging` sees an old transfer area, then (via a lock wrapper that runs a hook before `fn`) `stageChunk` touches the session; prune skips it.
- a backend without `listStaging` returns `{ removed: 0 }`.

- [ ] **Step 2: Run tests to verify they fail** — expected FAIL.
- [ ] **Step 3: Implement** per the spec's Staging maintenance section.
- [ ] **Step 4: Run tests to verify they pass** — expected PASS.
- [ ] **Step 5: Integration test** `blob-service.test.ts` in `describe.each(backends())`: write, read range, transfer between two services sharing nothing but bytes, `writeWith` rollback, delete, `list` pagination. Add `@hozon/blob`, `@hozon/blob-id`, `@hozon/blob-backend` to `tests/integration/package.json`. Run `cd tests/integration && rtk proxy pnpm run test -- blob-service`; expected PASS on SQLite and Postgres.
- [ ] **Step 6: Docs.** `packages/blob/README.md` (service API, lock order, `writeWith` constraints, multi-host lock caveat, store registration requirement); `docs/reference/blob-backends.md` (new backend methods, staging-ID consumption guarantee, file lock). Update `plugins/hozon/skills/database/SKILL.md` blob mention if it lists blob packages.
- [ ] **Step 7: Full verification.** From the repo root: `rtk proxy pnpm run build`, `rtk proxy pnpm run test`, `pnpm exec biome check .`; all PASS.
- [ ] **Step 8: Record versioning entries** per repo convention (`kigu:conventions`; new packages `@hozon/blob-id` and `@hozon/blob` minor, `@hozon/store-blob` and `@hozon/blob-backend` minor (breaking `beginTransfer` and new required backend method, pre-1.0), `@hozon/blob-node-fs` minor) and commit — `git commit -m "feat(blob): add staging maintenance, integration tests and docs"`
