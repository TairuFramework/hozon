# Blob storage and store table prefixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every hozon store honour `HozonDB`'s `tablePrefix`, then add the generic `@hozon/blob-backend`, `@hozon/blob-node-fs`, and `@hozon/store-blob` packages ported from kubun.

**Architecture:** A Kysely plugin (`TablePrefixPlugin`) rewrites unqualified table names from logical (`logs`) to physical (`<prefix>_logs`). `HozonDB` hands every store API and every store migration a plugged Kysely instance; the Kysely `Migrator` itself keeps the unplugged instance. The blob packages follow the same store pattern as `store-log`.

**Tech Stack:** TypeScript, Kysely 0.29.6, vitest 5, pnpm workspaces, turbo, biome, swc.

**Spec:** `docs/superpowers/specs/2026-10-06-store-blob-design.md`

**Kubun sources to port** (read-only, sibling repo):
- `/Users/paul/dev/yulsi/kubun/packages/blob-backend/src/{backend,memory,index}.ts`
- `/Users/paul/dev/yulsi/kubun/packages/blob-node-fs/src/{fs,index}.ts`, `test/backend.test.ts`
- `/Users/paul/dev/yulsi/kubun/packages/store-blob/src/{api,tables,migrations,definition,index}.ts`, `test/blob.test.ts`

## Global Constraints

- pnpm only. Run repo scripts as `rtk proxy pnpm run <script>` or invoke tools directly (`pnpm exec biome check ...`, `pnpm exec vitest run`, `pnpm exec tsc ...`).
- Never call `.transaction()` inside store methods; use `withStoreTransaction`.
- No statement may bind more than 500 parameters; batch with `chunk()` from `@hozon/db`.
- Store code uses logical, unprefixed table names; index and constraint names use `ctx.tablePrefix`.
- Store code must not reference system tables through the plugged instance.
- Physical table names under the default `hozon` prefix stay unchanged for `store-log` and `store-telemetry`.
- New packages: `"license": "MIT"`, `repository.directory` set, `publishConfig.access: public`, scripts and tsconfig files copied from `packages/store-log` (same `build*`, `prepack`, `test*` scripts).
- No `kubun` string in any new or changed file under `packages/` except tests that use `kubun` as a sample prefix value.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A store query that aliases a table (`selectFrom('blob_entries as e')`) or qualifies a column (`logs.seq`) must still work under a custom prefix: the alias is kept and the qualifier is prefixed. Covered in Task 1.
2. `withKeepSet` called from a store API under a custom prefix must create, fill, and drop `<prefix>_keep_<x>`, and two concurrent keep-set calls in one transaction must still serialize. Covered in Task 2.
3. Rolling a store migration down (`migration-rollback` path) under a custom prefix must drop the prefixed tables, not logical ones. Covered in Task 2.
4. `beginTransfer` or `finalizeTransfer` on a `blobID` with no entry must throw `Blob entry <id> not found`, not silently succeed or leave orphan chunk rows. Covered in Task 6.
5. Every `FSBlobBackend` method, including `has` and `getURL`, must reject an unsafe key (`../x`, `a/b`, `C:x`), not just the write paths. Covered in Task 5.

---

### Task 1: `TablePrefixPlugin`

**Files:**
- Create: `packages/db/src/table-prefix.ts`
- Modify: `packages/db/src/index.ts` (export)
- Test: `packages/db/test/table-prefix.test.ts`

**Interfaces:**
- Produces: `class TablePrefixPlugin implements KyselyPlugin { constructor(prefix: string) }`, exported from `@hozon/db`. Rewrites each `TableNode` whose `table.schema` is undefined to `TableNode.create(`${prefix}_${name}`)`; schema-qualified nodes are unchanged; `transformResult` returns the result unchanged.

- [ ] **Step 1: Write the failing tests**

Build a Kysely instance on an in-memory `@hozon/node-sqlite` adapter's dialect with `plugins: [new TablePrefixPlugin('kubun')]`, and assert on `.compile().sql`:

```ts
test('prefixes select, insert, update, delete', ...)
// selectFrom('logs').selectAll()      -> contains '"kubun_logs"'
// insertInto('logs').values({ a: 1 }) -> contains '"kubun_logs"'
// updateTable('logs').set({ a: 1 })   -> contains '"kubun_logs"'
// deleteFrom('logs')                  -> contains '"kubun_logs"'
test('keeps aliases and prefixes qualified columns', ...)
// selectFrom('logs as l').select('l.seq') -> contains '"kubun_logs" as "l"' and '"l"."seq"'
// selectFrom('logs').select('logs.seq')   -> contains '"kubun_logs"."seq"'
test('prefixes joins', ...)
// selectFrom('a').innerJoin('b', 'a.id', 'b.id') -> '"kubun_a"' and '"kubun_b"'
test('prefixes sql.table in raw templates', ...)
// sql`DROP TABLE ${sql.table('keep_log')}` compiled via db -> contains '"kubun_keep_log"'
test('prefixes schema builder tables but not index names', ...)
// schema.createTable('logs')... -> '"kubun_logs"'
// schema.createIndex('my_idx').on('logs').column('a') -> '"my_idx"' and '"kubun_logs"'
// schema.dropTable('logs') -> '"kubun_logs"'
test('leaves schema-qualified tables unchanged', ...)
// selectFrom('main.logs') -> contains '"main"."logs"', not 'kubun_'
```

Also run one real round trip: create table `items`, insert, select, then query `sqlite_master` through an unplugged instance and expect `kubun_items`.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/db && pnpm exec vitest run test/table-prefix.test.ts`
Expected: FAIL, cannot resolve `../src/table-prefix.js`.

- [ ] **Step 3: Implement `TablePrefixPlugin` in `packages/db/src/table-prefix.ts`**

A private `OperationNodeTransformer` subclass overriding `protected override transformTable(node: TableNode, queryId?: QueryId): TableNode`. The plugin's `transformQuery({ node, queryId })` returns `transformer.transformNode(node, queryId)`. Export from `index.ts`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd packages/db && pnpm exec vitest run test/table-prefix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/table-prefix.ts packages/db/src/index.ts packages/db/test/table-prefix.test.ts
git commit -m "feat(db): add TablePrefixPlugin"
```

### Task 2: Wire the prefix into `HozonDB`

**Files:**
- Modify: `packages/db/src/db.ts` (`MigrationContext`, constructor, `getStore`, `withTransaction`, `#getMigrations`)
- Test: `packages/db/test/table-prefix-db.test.ts`
- Modify: `docs/superpowers/specs/2026-10-06-store-blob-design.md` (replace the keep-set lock-key bullet, see Step 3)

**Interfaces:**
- Consumes: `TablePrefixPlugin` (Task 1).
- Produces: `MigrationContext.tablePrefix: string`. Store `createAPI` and store migration `up`/`down` receive a Kysely instance that prefixes tables with the `HozonDB` `tablePrefix`.

- [ ] **Step 1: Write the failing tests**

A test store `widgets` with migration `0-init` creating table `widgets` (`id` text primary key) and index `${ctx.tablePrefix}_widgets_id`, `down` dropping it, and an API with `add(id)`, `list()`, and `keep(ids)` (runs `withStoreTransaction` + `withKeepSet(trx, { table: 'keep_widgets', ids }, ...)` and returns kept ids). Use `new HozonDB({ adapter, tablePrefix: 'kubun' })` on node-sqlite. Inspect physical names with raw `sql` on `db.adapter`'s own Kysely or `sqlite_master`.

```ts
test('store tables and indexes use the db prefix')
// sqlite_master names include 'kubun_widgets', 'kubun_widgets_id', 'kubun_widgets_migration'; none equals 'widgets'
test('migration context exposes tablePrefix')        // captured ctx.tablePrefix === 'kubun'
test('migrating twice is a no-op and never double-prefixes')
// reopen on the same file, getStore again; no name starts with 'kubun_kubun_'
test('store API in withTransaction uses the prefix') // tx.getStore('widgets').add, then list() sees it
test('keep-set temp table is prefixed and calls serialize')
// two concurrent keep() calls inside one withTransaction both resolve with their own ids
test('default prefix keeps hozon_ names')            // no tablePrefix -> 'hozon_widgets'
test('migration down drops prefixed tables')
// run the Migrator down path the same way packages/db/test/migration-rollback.test.ts does; 'kubun_widgets' is gone
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/db && pnpm exec vitest run test/table-prefix-db.test.ts`
Expected: FAIL, tables named `widgets`, `ctx.tablePrefix` undefined.

- [ ] **Step 3: Implement**

- Add `tablePrefix: string` to `MigrationContext`; pass `this.#tablePrefix` in `#getMigrations`.
- Constructor: keep `this.#db` unplugged (Migrator, preflight); add `#storeDB = this.#db.withPlugin(new TablePrefixPlugin(this.#tablePrefix))`.
- `getStore`: `store.createAPI(this.#storeDB, ...)`.
- `withTransaction`: open the transaction from `#storeDB` so `txKysely` inherits the plugin. One plugged instance per transaction, shared by every store, keeps `withKeepSet`'s per-instance locks working as today. Savepoint names are identifiers, not tables, so they are unaffected.
- `#getMigrations`: wrap each migration as `{ up: (db) => m.up(db.withPlugin(plugin)), down: m.down && ((db) => m.down(db.withPlugin(plugin))) }`. The Migrator keeps `migrationTableName: `${prefix}_${name}_migration`` on the unplugged db.
- In the spec, replace "Keep-set lock keys use the physical (prefixed) table name, so two prefixes on one database do not share a lock." with "All stores in one transaction share one plugged Kysely instance, so `withKeepSet`'s per-instance locks behave as before."

- [ ] **Step 4: Run the db package tests**

Run: `cd packages/db && pnpm exec vitest run && pnpm exec tsc --noEmit --skipLibCheck -p tsconfig.test.json`
Expected: all PASS, including the existing `transaction`, `keep-set`, `preflight`, and `migration-rollback` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db docs/superpowers/specs/2026-10-06-store-blob-design.md
git commit -m "feat(db): apply table prefix to store APIs and migrations"
```

### Task 3: Logical table names in `store-log` and `store-telemetry`

**Files:**
- Modify: `packages/store-log/src/{tables,migrations,api}.ts`
- Modify: `packages/store-telemetry/src/{tables,migrations,api}.ts`
- Test: `packages/store-log/test/store-log.test.ts`, `packages/store-telemetry/test/store-telemetry.test.ts`

**Interfaces:**
- Consumes: `MigrationContext.tablePrefix` and the plugged instance (Task 2).
- Produces: `LogTables = { logs: ... }`, `TelemetryTables = { spans: ... }`.

- [ ] **Step 1: Write the failing tests**

In each store test file add `test('uses a custom table prefix')`: open `HozonDB({ adapter, tablePrefix: 'kubun' })`, write one log or span through the API, read it back, then assert `sqlite_master` lists `kubun_logs` plus `kubun_logs_timestamp`, `kubun_logs_trace_timestamp_seq`, `kubun_logs_level_timestamp` (telemetry: `kubun_spans`, `kubun_spans_trace_start_seq`, `kubun_spans_end_time`, and the unique constraint `kubun_spans_trace_span` where SQLite reports it as an autoindex-backed constraint, so check the `CREATE TABLE` sql text contains it). Also run a retention call with `keepTraceIDs` so the keep-set path runs under the prefix.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd packages/store-log && pnpm exec vitest run` (then the same in `packages/store-telemetry`)
Expected: FAIL, the physical table is `kubun_hozon_logs`.

- [ ] **Step 3: Implement**

Rename: `hozon_logs` to `logs`, `hozon_keep_log` to `keep_log`, `hozon_spans` to `spans`, `hozon_keep_telemetry` to `keep_telemetry`. Index and constraint names become `${ctx.tablePrefix}_logs_timestamp`, `${ctx.tablePrefix}_logs_trace_timestamp_seq`, `${ctx.tablePrefix}_logs_level_timestamp`, `${ctx.tablePrefix}_spans_trace_span`, `${ctx.tablePrefix}_spans_trace_start_seq`, `${ctx.tablePrefix}_spans_end_time`. Raw-SQL assertions in existing tests that name `hozon_*` physical tables stay as they are (default prefix).

- [ ] **Step 4: Run tests, verify they pass**

Run: `rtk proxy pnpm run test` from the repo root, then `rtk proxy pnpm run test:integration` (needs Docker for postgres, see `tests/integration/README.md`).
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store-log packages/store-telemetry
git commit -m "feat(stores): use logical table names under the db prefix"
```

### Task 4: `@hozon/blob-backend`

**Files:**
- Create: `packages/blob-backend/{package.json,tsconfig.json,tsconfig.test.json,README.md}`
- Create: `packages/blob-backend/src/{backend,memory,index}.ts`
- Test: `packages/blob-backend/test/memory.test.ts`

**Interfaces:**
- Produces: `type BlobRange = { start: number; end: number }` (inclusive); `type BlobBackend` with `createStaging(stagingID): Promise<WritableStream<Uint8Array>>`, `writeChunk(stagingID, offset, bytes): Promise<void>`, `commit(stagingID, key): Promise<void>`, `abortStaging(stagingID): Promise<void>`, `createReadStream(key, range?): Promise<ReadableStream<Uint8Array>>`, `has(key): Promise<boolean>`, `delete(key): Promise<void>`, `getURL(key): Promise<string | null>`; `class MemoryBlobBackend implements BlobBackend`.

- [ ] **Step 1: Scaffold the package**

`package.json`: name `@hozon/blob-backend`, version `0.1.0`, description `Byte storage interface and in-memory backend for Hozon blobs`, no dependencies, devDependencies `del-cli`, `vitest`, `@types/node` (catalog). Then `pnpm install`.

- [ ] **Step 2: Write the failing tests**

```ts
test('sequential staging then commit reads back the bytes')
test('out-of-order writeChunk assembles by offset')   // chunks at offsets 4 then 0 -> [0..7]
test('commit is idempotent for an existing key and drops the staging area')
test('commit without staging throws "No staging area for s1"')
test('ranged read is inclusive')                      // bytes 0..9, range {start: 2, end: 4} -> [2,3,4]
test('read of a missing key throws "No blob for key k"')
test('delete then has() is false; getURL() is null')
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd packages/blob-backend && pnpm exec vitest run`
Expected: FAIL, missing `../src/memory.js`.

- [ ] **Step 4: Port `backend.ts`, `memory.ts`, `index.ts` from kubun**

Code unchanged. Comments: replace the `backend.ts` header with the generic one (the store owns hashing and the key format; the backend never inspects content). Drop every mention of AttachmentID, plugin-blob, and kubun.

- [ ] **Step 5: Run tests and type check**

Run: `cd packages/blob-backend && rtk proxy pnpm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/blob-backend pnpm-lock.yaml
git commit -m "feat(blob-backend): add BlobBackend interface and MemoryBlobBackend"
```

### Task 5: `@hozon/blob-node-fs`

**Files:**
- Create: `packages/blob-node-fs/{package.json,tsconfig.json,tsconfig.test.json,README.md}`
- Create: `packages/blob-node-fs/src/{fs,index}.ts`
- Test: `packages/blob-node-fs/test/backend.test.ts`

**Interfaces:**
- Consumes: `BlobBackend`, `BlobRange`, `MemoryBlobBackend` (Task 4).
- Produces: `class FSBlobBackend implements BlobBackend { constructor(root: string) }`.

- [ ] **Step 1: Scaffold**

Name `@hozon/blob-node-fs`, version `0.1.0`, description `Node filesystem BlobBackend for Hozon`, dependency `@hozon/blob-backend: workspace:^`, `engines.node: ">=24"`. Then `pnpm install`.

- [ ] **Step 2: Port and extend the tests**

Port kubun's `test/backend.test.ts`. It runs one behaviour suite against `MemoryBlobBackend` and `FSBlobBackend`; change the temp dir prefix to `hozon-blob-`. Add:

```ts
test.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'C:x', 'a\0b'])('rejects unsafe key %j', ...)
// every method that takes a key (commit's key arg, createReadStream, has, delete, getURL)
// and every method that takes a stagingID (createStaging, writeChunk, commit, abortStaging)
// rejects with Error 'Invalid blob key: <JSON.stringify(value)>'
test('content stays inside root')  // after commit of key 'abc', file exists at join(root, 'content', 'abc')
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd packages/blob-node-fs && pnpm exec vitest run`
Expected: FAIL, missing `../src/fs.js`.

- [ ] **Step 4: Port `fs.ts`, add validation**

Port kubun's `FSBlobBackend`, importing from `@hozon/blob-backend`. Add a module function `assertSafeName(value: string): void` that throws `new Error(`Invalid blob key: ${JSON.stringify(value)}`)` when the value is empty, is `.`, contains `..`, or contains any of `/`, `\`, `:`, `\0`. Call it from `#stagingPath` and `#contentPath`, so every method is covered. Replace the "AttachmentID base36 strings" comment with the validation rule.

- [ ] **Step 5: Run tests and type check**

Run: `cd packages/blob-node-fs && rtk proxy pnpm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/blob-node-fs pnpm-lock.yaml
git commit -m "feat(blob-node-fs): add FSBlobBackend with key validation"
```

### Task 6: `@hozon/store-blob`

**Files:**
- Create: `packages/store-blob/{package.json,tsconfig.json,tsconfig.test.json,README.md}`
- Create: `packages/store-blob/src/{tables,migrations,api,definition,types,index}.ts`
- Test: `packages/store-blob/test/store-blob.test.ts`

**Interfaces:**
- Consumes: `withStoreTransaction`, `chunk`, `MigrationContext.tablePrefix`, `StoreDefinition`, `StoreProvider` from `@hozon/db`; `Adapter` from `@hozon/adapter`.
- Produces (all from `@hozon/store-blob`):
  - `BLOB_STORE = 'blob'`, `blobStoreDefinition: StoreDefinition<BlobTables, BlobStoreAPI>`, `getBlobStore(provider: StoreProvider): Promise<BlobStoreAPI>`
  - `type BlobState = 'local' | 'partial' | 'remote-only'`
  - `type BlobEntryInput = { blobID: string; contentLength: number; encrypted?: boolean; keyID?: string | null; chunkSize: number; state: BlobState; pinned?: boolean; createdAt: number }`
  - `type BlobChunkInput = { index: number; digest: Uint8Array }`
  - `type BlobEntry = { blobID: string; contentLength: number; encrypted: boolean; keyID: string | null; chunkSize: number; state: BlobState; pinned: boolean; createdAt: number }`
  - `type BlobStoreAPI`: `insertEntry(entry, chunks)`, `getEntry(blobID): Promise<BlobEntry | null>`, `getChunkDigests(blobID): Promise<Array<Uint8Array>>`, `setPinned(blobID, pinned)`, `deleteEntry(blobID)`, `beginTransfer(blobID, chunkSize, chunks)`, `recordTransferChunk(blobID, index)`, `getPresentChunkIndexes(blobID): Promise<Array<number>>`, `finalizeTransfer(blobID)`; all mutators return `Promise<void>`
  - Table types `BlobTables = { blob_entries; blob_chunks; blob_transfers }` with `BlobEntryTable`, `BlobChunkTable`, `BlobTransferTable`

- [ ] **Step 1: Scaffold**

Name `@hozon/store-blob`, version `0.1.0`, description `Content-addressed blob metadata and resumable transfer store for Hozon`, dependencies `@hozon/adapter`, `@hozon/db` (workspace), `kysely` (catalog), devDependencies `@hozon/node-sqlite` (workspace), `@types/node`, `del-cli`, `vitest`. Then `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Port kubun's `test/blob.test.ts` to `HozonDB` + `@hozon/node-sqlite` only (no postgres container, no refs tests), with `attachmentID` renamed to `blobID`. Assertions to keep or add:

```ts
test('insertEntry then getEntry returns the mapped entry')
// encrypted: true, keyID: 'k1', pinned: false, state: 'local' -> booleans, not 0/1
test('insertEntry is idempotent on blobID')    // second insert with other fields leaves the first row
test('getChunkDigests returns digests ordered by index')  // inserted out of order
test('stores a manifest of 600 chunks')        // getChunkDigests length 600, byte-equal digests
test('setPinned toggles pinned')
test('deleteEntry removes entry, chunks, and transfer rows')
// after beginTransfer + recordTransferChunk + deleteEntry: getEntry null, digests [], present []
test('transfer lifecycle')
// remote-only entry -> beginTransfer(id, 4, chunks 0..2) -> state 'partial', chunkSize 4
// recordTransferChunk twice for index 1 -> present [1]; record 0, 2 -> finalize -> state 'local', present []
test('finalizeTransfer throws when chunks are missing')
// message 'Cannot finalize transfer b1: 1 chunk(s) missing'; state stays 'partial'
test('beginTransfer and finalizeTransfer throw for an unknown blob')   // 'Blob entry nope not found'; no chunk rows written
test('beginTransfer is atomic')                // unknown blob with 3 chunks -> blob_chunks stays empty
test('uses a custom table prefix')             // tablePrefix 'kubun' -> sqlite_master has kubun_blob_entries, kubun_blob_chunks, kubun_blob_transfers
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd packages/store-blob && pnpm exec vitest run`
Expected: FAIL, missing `../src/definition.js`.

- [ ] **Step 4: Implement**

- `tables.ts`: kubun's table types with logical keys, `attachment_id` renamed `blob_id`, `state: BlobState`, no refs table. Comments are generic (no AttachmentID, credential subsystem, or GC seam).
- `migrations.ts`: `0-init` as kubun's, minus `blob_refs`, with logical table names, `.ifNotExists()` removed (match `store-log`), and primary key constraint names `${ctx.tablePrefix}_blob_chunks_pkey` and `${ctx.tablePrefix}_blob_transfers_pkey`. `down` drops the three tables in reverse order.
- `api.ts`: `createBlobStoreAPI(db, adapter)`. `insertEntry`, `deleteEntry` (deleting transfers, chunks, entry in that order), `beginTransfer`, and `finalizeTransfer` run inside `withStoreTransaction`. Chunk inserts loop over `chunk(rows, 166)`. Digests go through `adapter.encodeBinary`. `beginTransfer` and `finalizeTransfer` first select the entry and throw `new Error(`Blob entry ${blobID} not found`)` when absent. `getEntry` maps the row to `BlobEntry`.
- `definition.ts`: `BLOB_STORE`, `blobStoreDefinition`, `getBlobStore`, in the `store-log` shape.
- `index.ts`: the exports listed under Interfaces.

- [ ] **Step 5: Run tests and type check**

Run: `cd packages/store-blob && rtk proxy pnpm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store-blob pnpm-lock.yaml
git commit -m "feat(store-blob): add blob metadata and transfer store"
```

### Task 7: Integration coverage on Postgres and SQLite

**Files:**
- Modify: `tests/integration/package.json` (add `@hozon/store-blob: workspace:^`)
- Create: `tests/integration/test/store-blob.test.ts`

**Interfaces:**
- Consumes: `blobStoreDefinition`, `getBlobStore`, `BlobStoreAPI` (Task 6); `backends()` from `tests/integration/src/backends.ts`.

- [ ] **Step 1: Write the tests**

Follow `tests/integration/test/store-log.test.ts`'s `describe.each(backends())` shape. Tests: entry round trip with a `created_at` of `Date.now()` and `content_length` of `5 * 1024 ** 3` (bigint columns read back as numbers equal to the input), 600-chunk manifest digests byte-equal, transfer lifecycle through finalize, and a `tablePrefix: 'kubun'` run that writes and reads one entry.

- [ ] **Step 2: Run them**

Run: `pnpm install && rtk proxy pnpm run test:integration`
Expected: PASS on every backend.

- [ ] **Step 3: Commit**

```bash
git add tests/integration pnpm-lock.yaml
git commit -m "test(integration): cover store-blob on all backends"
```

### Task 8: Docs, skills, release intents

**Files:**
- Modify: `plugins/hozon/skills/database/SKILL.md`, `plugins/hozon/skills/discover/SKILL.md`
- Modify: `docs/reference/db.md`, `docs/reference/stores.md`, `docs/index.md`
- Create: `.changeset/table-prefix-db.md`, `.changeset/table-prefix-stores.md`, `.changeset/initial-blob-backend.md`, `.changeset/initial-blob-node-fs.md`, `.changeset/initial-store-blob.md`

- [ ] **Step 1: Document the prefix rules**

In `database/SKILL.md` and `docs/reference/db.md`: `tablePrefix` now applies to store tables; store code uses logical table names; index and constraint names use `ctx.tablePrefix`; no system tables through the store instance; `TablePrefixPlugin` is exported.

- [ ] **Step 2: Document the blob packages**

`docs/reference/stores.md` gets a store-blob section (tables, API, transfer lifecycle) and a BlobBackend section (both implementations, FS key rules). `discover/SKILL.md` and `docs/index.md` list the three packages. Package READMEs follow `packages/store-log/README.md`.

- [ ] **Step 3: Release intents**

Same format as the deleted `0fb75c6` intents. `@hozon/db: minor` "Store tables honour `tablePrefix`; add `TablePrefixPlugin` and `MigrationContext.tablePrefix`." `@hozon/store-log` and `@hozon/store-telemetry: minor` "Use logical table names so a custom `tablePrefix` applies; default physical names unchanged." `@hozon/blob-backend`, `@hozon/blob-node-fs`, `@hozon/store-blob: minor` "Initial release."

- [ ] **Step 4: Verify**

Run: `rtk proxy pnpm run check:skills && pnpm exec biome ci . && rtk proxy pnpm run build && rtk proxy pnpm run test`
Expected: all PASS, and `grep -rni kubun packages/*/src docs/reference docs/index.md plugins` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add plugins docs .changeset packages/*/README.md
git commit -m "docs: document table prefixes and blob packages"
```
