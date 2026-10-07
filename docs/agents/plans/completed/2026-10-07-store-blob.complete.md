# Blob storage and store table prefixes

Status: complete (branch `feat/store-blob`)

## Goal

Move kubun's `blob-backend`, `blob-node-fs`, and `store-blob` into hozon as generic
packages with no kubun-specific logic, and let every hozon store use the `HozonDB`
table prefix so kubun can keep its own table naming.

## What was built

- **`TablePrefixPlugin` in `@hozon/db`.** `HozonDB({ tablePrefix })` passes a plugged
  Kysely instance to store APIs, transactions, and the `up`/`down` of each store
  migration. The `Migrator` keeps the unplugged instance, so its migration and lock
  tables are prefixed once. `MigrationContext` gains `tablePrefix` for index and
  constraint names.
- **`store-log` and `store-telemetry`** use logical table names (`logs`, `spans`,
  `keep_log`, `keep_telemetry`). Under the default `hozon` prefix the physical
  names are unchanged.
- **`@hozon/blob-backend`.** The `BlobBackend` interface: Web Streams staging,
  positioned chunk writes, content-addressed commit, and ranged reads. Also
  `MemoryBlobBackend`.
- **`@hozon/blob-node-fs`.** `FSBlobBackend(root)` stores staged uploads under
  `staging/` and blobs under `content/`.
- **`@hozon/store-blob`.** Tables `blob_entries`, `blob_chunks`, and `blob_transfers`
  hold blob metadata, the chunk manifest, and resumable transfer state. Chunk and
  transfer rows reference their entry through cascading foreign keys.
- Integration coverage for SQLite and Postgres, docs, skills, and changesets.

## Key design decisions

- **One prefix per database, not per store.** A store's tables and its migration
  tables always share a prefix.
- **Store code uses logical names.** It never reads system tables through the
  plugged instance.
- **Prefix plugin rules.** It is modelled on Kysely's `WithSchemaTransformer` and:
  - prefixes table positions and raw `sql.table()`;
  - prefixes column qualifiers only when they name a real table collected in scope,
    so aliases stay unprefixed;
  - never treats CTE names as tables, but a CTE never exempts a physical write
    target;
  - leaves schema-qualified names alone;
  - is idempotent: it tracks the identifier nodes it produced, so subqueries built
    from the plugged instance and cloned view nodes are prefixed exactly once.
- **No migration for existing custom-prefix databases.** A database created with a
  non-default `tablePrefix` must be reset, because `hozon_*` tables become
  `<prefix>_*`. The `store-log`/`store-telemetry` changeset and the `db` reference
  docs say so.
- **Kubun-specific code stays in kubun.** That covers document refs (`blob_refs` and
  its methods), the blob byte route constant, and the plugin system. `attachmentID`
  is renamed `blobID`.
- **Store guardrails apply to the ported code.** Writes go through
  `withStoreTransaction`. Manifest inserts are chunked at 166 rows, staying within
  500 bound parameters.
- **`store-blob` validates its inputs.**
  - `beginTransfer` rejects a chunk size change while a manifest exists.
  - `recordTransferChunk` rejects unknown blobs and indexes.
  - `deleteEntry` also purges transfer rows.
- **The backends are hardened beyond the kubun originals.**
  - `MemoryBlobBackend` copies buffers in and out.
  - `FSBlobBackend` validates keys and staging IDs: it rejects empty strings, `/`,
    `\`, `..`, and NUL.
  - `FSBlobBackend` retries short positioned writes.
  - `FSBlobBackend` commits with a hard link, so an existing blob is never replaced
    and duplicate commits are idempotent. This requires a filesystem with hard-link
    support.

## Follow-on

- [Kubun adoption](../next/2026-10-07-kubun-adopt-hozon-blob.md)
- [Windows CI for blob-node-fs](../backlog/2026-10-07-blob-node-fs-windows-ci.md)
