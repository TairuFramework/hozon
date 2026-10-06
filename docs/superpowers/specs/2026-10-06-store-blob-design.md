# Blob storage and store table prefixes — design

Date: 2026-10-06
Branch: `feat/store-blob`

## Goal

Move kubun's `blob-backend`, `blob-node-fs`, and `store-blob` packages into hozon
as generic packages with no kubun-specific logic, so that kubun (and other repos)
can depend on them. Kubun must keep its current functionality by layering its
kubun-specific pieces on top of the hozon packages.

To let kubun keep its own table naming, every hozon store gains support for the
`HozonDB` table prefix.

## Constraints and decisions

- Kubun does not need a data migration: a fresh design and a DB reset are
  acceptable for kubun.
- Physical table names under the default `hozon` prefix stay unchanged for
  existing stores (`hozon_logs`, `hozon_spans`), so existing hozon users see no
  schema change.
- The prefix is configured once per database (`HozonDB({ tablePrefix })`), not
  per store. A store's tables and its migration tables always share a prefix.
- Kubun-specific features stay in kubun: document references (`blob_refs`), the
  blob byte HTTP route constant, and the plugin system (`plugin-blob` is not
  moved).
- Hozon guardrails apply to the ported code: no `.transaction()` inside store
  methods (use `withStoreTransaction`), and no statement binds more than 500
  parameters.

## Part 1 — Table prefix in `@hozon/db`

### `TablePrefixPlugin`

A new Kysely plugin exported from `@hozon/db`, built on
`OperationNodeTransformer`. It rewrites every unqualified `TableNode` from `x` to
`${prefix}_x`. Schema-qualified table references are left unchanged. Because
`sql.table()` produces a `TableNode` inside a `RawNode`, raw templates are
rewritten too; this covers the keep-set temp tables.

### Wiring

- `createAPI` receives `db.withPlugin(new TablePrefixPlugin(prefix))`, both for the
  root store APIs and for per-transaction store APIs. Transactions and
  `withStoreTransaction` inherit the plugin.
- The Kysely `Migrator` keeps the unplugged instance, so its own
  `${prefix}_${name}_migration` and `${prefix}_${name}_migration_lock` tables and
  its introspection behave as today. Each store migration's `up` and `down` are
  wrapped so that they receive the plugged instance. This prevents migration
  tables from being double-prefixed.
- `MigrationContext` gains `tablePrefix: string`. Migrations use it for names
  that are not table references: index names and constraint names, for example
  `${ctx.tablePrefix}_logs_timestamp`.
- Keep-set lock keys use the physical (prefixed) table name, so two prefixes on
  one database do not share a lock.

### Rules for store authors

- Store code (APIs and migrations) uses logical, unprefixed table names, and the
  `Tables` type is keyed by logical names.
- Store code must not reference system tables (`sqlite_master`,
  `information_schema`, ...) through the plugged instance.
- Index and constraint names are built from `ctx.tablePrefix`.

These rules are documented in the `hozon:database` skill and in
`docs/reference/db.md` / `docs/reference/stores.md`.

### Store updates

- `store-log`: `hozon_logs` becomes `logs`; the keep-set table `hozon_keep_log`
  becomes `keep_log`; index names use `ctx.tablePrefix`; the `LogTables` key
  becomes `logs`.
- `store-telemetry`: `hozon_spans` becomes `spans`; `hozon_keep_telemetry`
  becomes `keep_telemetry`; the unique constraint and index names use
  `ctx.tablePrefix`; the `TelemetryTables` key becomes `spans`.

### Tests

- Plugin unit tests: select, insert, update, delete, join, raw `sql.table`, and
  schema builder (create table, create index, drop table), plus a
  schema-qualified reference that stays unchanged.
- `store-log` and `store-telemetry` run under a custom prefix (`kubun`); tests
  assert the physical table names.
- The migrator runs twice under a custom prefix: the second run is a no-op and no
  double-prefixed table exists.

## Part 2 — Blob packages

### `@hozon/blob-backend`

No dependencies. Ported as-is:

- `BlobBackend`: byte storage that stages an upload (`createStaging` for
  sequential writes, `writeChunk` for out-of-order positioned writes), promotes
  it to a content-addressed key (`commit`, idempotent), and serves bytes
  (`createReadStream` with an optional inclusive `BlobRange`, `has`, `delete`,
  `getURL`). Built on Web Streams for portability across Node, browser, and Expo.
- `BlobRange`: inclusive `start` / `end` byte offsets.
- `MemoryBlobBackend`: in-memory implementation for tests and ephemeral use.

Comments are generalized: the store owns hashing and the key format, and mentions
of AttachmentID and plugin-blob are removed.

### `@hozon/blob-node-fs`

Depends on `@hozon/blob-backend`. `FSBlobBackend(root)` is ported with the same
layout: staged uploads under `<root>/staging/<stagingID>`, committed blobs under
`<root>/content/<key>`, and commit as an atomic rename within one filesystem.

New: keys and staging IDs are validated before they are used as file names. An
empty string, or one containing `/`, `\`, `..`, or NUL, is rejected with an
error. Kubun's ids were safe by construction; generic callers are not, and an
unchecked value would allow path traversal outside `root`.

### `@hozon/store-blob`

Depends on `@hozon/db`, `@hozon/adapter`, and `kysely`. It stores blob metadata,
the chunk manifest, and resumable transfer state; byte storage lives in a
`BlobBackend`.

Tables (logical names, prefixed per Part 1):

- `blob_entries`: `blob_id` (text, primary key), `content_length` (bigint),
  `encrypted` (integer 0/1), `key_id` (text, nullable), `chunk_size` (integer),
  `state` (text: `local`, `partial`, `remote-only`), `pinned` (integer 0/1),
  `created_at` (bigint, ms epoch).
- `blob_chunks`: `blob_id`, `index`, `digest` (binary); primary key
  `(blob_id, index)`. Persists after a transfer is finalized, so a node can
  verify and serve ranges.
- `blob_transfers`: `blob_id`, `index`; primary key `(blob_id, index)`. The
  present-chunk set for an in-flight download; purged on finalize.

API (`BlobStoreAPI`):

- `insertEntry(entry, chunks)`: idempotent on `blobID` (do nothing on conflict).
- `getEntry(blobID)`: returns a mapped `BlobEntry` (`blobID`, `contentLength`,
  `encrypted: boolean`, `keyID: string | null`, `chunkSize`, `state: BlobState`,
  `pinned: boolean`, `createdAt`) or `null`.
- `getChunkDigests(blobID)`: digests ordered by index.
- `setPinned(blobID, pinned)`.
- `deleteEntry(blobID)`: removes the entry, its chunks, and its transfer rows.
- `beginTransfer(blobID, chunkSize, chunks)`: records the manifest and moves the
  entry to `partial`.
- `recordTransferChunk(blobID, index)`: idempotent.
- `getPresentChunkIndexes(blobID)`.
- `finalizeTransfer(blobID)`: throws if any manifest chunk is missing; otherwise
  moves the entry to `local` and purges its transfer rows.

`encrypted` and `keyID` are kept as generic optional metadata ("these bytes are
ciphertext under this key"); hozon does not interpret them.

Changes from the kubun version:

- `attachmentID` is renamed to `blobID` throughout.
- The refs table and its four methods (`putRef`, `getRefsForDocument`,
  `getRefsForAttachment`, `removeRefsForDocument`) are removed.
- `BLOB_BYTE_ROUTE_PREFIX` is removed.
- `insertEntry`, `deleteEntry`, `beginTransfer`, and `finalizeTransfer` run inside
  `withStoreTransaction`.
- Chunk inserts are batched with `chunk()`: 3 parameters per row, so at most 166
  rows per statement.
- `deleteEntry` also purges `blob_transfers` rows (kubun leaves them orphaned).
- `getEntry` returns a mapped domain object instead of the raw row.

Exports: `blobStoreDefinition`, `BLOB_STORE`, `getBlobStore`, `BlobStoreAPI`,
`BlobEntry`, `BlobEntryInput`, `BlobChunkInput`, `BlobState`, and the table
types.

### Tests

- Backend behaviour suite run against both `MemoryBlobBackend` and
  `FSBlobBackend`: sequential staging, out-of-order chunks, idempotent commit,
  abort, ranged reads, `has` / `delete` / `getURL`.
- `FSBlobBackend` key and staging-ID validation cases.
- Store unit tests on `@hozon/node-sqlite`: entry lifecycle, a manifest of more
  than 500 chunks, the transfer lifecycle including a missing-chunk failure,
  `deleteEntry` purging transfers, and a run under a custom prefix.
- Postgres coverage through the existing `tests/integration` pattern.

## Docs and release

- Update the `hozon:database` skill and `docs/reference` pages for the prefix
  rules; add the blob packages to `hozon:discover` and the reference docs; add a
  README per new package.
- Release intents (per `kigu:releasing`): minor for `@hozon/db`,
  `@hozon/store-log`, and `@hozon/store-telemetry`; initial releases for the
  three new packages.

## Out of scope (kubun follow-up, separate spec in the kubun repo)

- Switching kubun from `KubunDB` to `HozonDB({ tablePrefix: 'kubun' })`.
- A kubun-owned `blob-refs` store (`dependsOn: ['blob']`) providing `blob_refs`
  and `putRef`, `getRefsForDocument`, `getRefsForAttachment`,
  `removeRefsForDocument`.
- Moving `BLOB_BYTE_ROUTE_PREFIX` into `plugin-blob`.
- Deleting kubun's `blob-backend`, `blob-node-fs`, and `store-blob` packages, and
  resetting kubun databases.

## Implementation order

1. Part 1: `TablePrefixPlugin`, wiring, `MigrationContext.tablePrefix`, and the
   `store-log` / `store-telemetry` updates.
2. Part 2: `@hozon/blob-backend`, then `@hozon/blob-node-fs`, then
   `@hozon/store-blob`.
3. Docs and release intents.
