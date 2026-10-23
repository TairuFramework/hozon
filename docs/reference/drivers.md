# Drivers

All drivers implement the `@hozon/adapter` contract. `HozonDB` owns their lifecycle and calls optional `prepare()` and `close()` hooks.

The concrete driver package exports are declared below. Inherited adapter methods are listed in [adapter](adapter.md).

```ts
type SQLitePragmas = {
  journalMode?: 'wal' | 'delete' | 'truncate' | 'memory' | 'off'
  busyTimeout?: number
  foreignKeys?: boolean
}
type NodeSQLiteAdapterParams = { database: string; pragmas?: SQLitePragmas }
class NodeSQLiteAdapter extends AbstractSQLiteAdapter<SQLiteTypes> {
  constructor(params: NodeSQLiteAdapterParams)
  get database(): DatabaseSync
  get dialect(): Dialect
  prepare(): Promise<void>
  close(): Promise<void>
}
type PostgresAdapterParams = {
  url: string; options?: Options<Record<string, PostgresType>>; closeTimeoutSeconds?: number
}
class PostgresAdapter extends AbstractPostgresAdapter {
  constructor(params: PostgresAdapterParams)
  get dialect(): Dialect
  coerceFilterValue(value: unknown): unknown
  close(): Promise<void>
}
type ExpoAdapterParams = { database: string; encryptionKey?: Uint8Array }
class ExpoAdapter extends AbstractSQLiteAdapter<SQLiteTypes> {
  constructor(params: ExpoAdapterParams)
  get database(): SQLiteDatabase
  get dialect(): Dialect
  close(): Promise<void>
}
type SQLocalAdapterParams = { database: string }
class SQLocalAdapter extends AbstractSQLiteAdapter<SQLiteTypes> {
  constructor(params: SQLocalAdapterParams)
  get dialect(): Dialect
  search: undefined
  get sqlocal(): SQLocalKysely
  close(): Promise<void>
}
```

## Node SQLite

`NodeSQLiteAdapter({ database, pragmas? })` accepts a path or `:memory:`. The `SQLitePragmas` options are `journalMode`, `busyTimeout`, and `foreignKeys`. Defaults are WAL for files, a 5000 ms busy timeout, and foreign keys enabled. Node packages require Node 24 or later. Node's SQLite binding converts booleans to `1` or `0` for all supported Node 24 releases.

Electron applications can use `node:sqlite` in the main process. Mark `node:sqlite` external in the main-process bundler configuration.

## PostgreSQL

`PostgresAdapter({ url, options?, closeTimeoutSeconds? })` accepts postgres.js options and a close deadline. Int8/bigint columns parse to JavaScript `Number` by default. Values above 2^53 may lose precision. Caller-provided type parsers take precedence. Boolean filter values remain native booleans for postgres.js.

## Expo SQLite

`ExpoAdapter({ database, encryptionKey? })` opens an Expo SQLite database and enables foreign keys. `encryptionKey` is a raw 32-byte SQLCipher key. It requires `useSQLCipher: true` in the `expo-sqlite` config plugin. The adapter throws if SQLCipher is not linked or the key does not match the file. Booleans serialize as `1` or `0`; dates serialize as ISO strings.

Hermes cannot compile Kysely's `FileMigrationProvider` because its dynamic import uses a variable path (kysely#1628, imported through `kysely/migration`). Wrap the Metro config with `withHozonMetroConfig` from `@hozon/expo/metro`. See the [Expo README](../../packages/expo/README.md).

## SQLocal

`SQLocalAdapter({ database })` requires browser cross-origin isolation headers (`COOP` and `COEP`) and OPFS. Verify `sqlocal.getDatabaseInfo().storageType` is `opfs` when persistence matters. Playwright WebKit 26.6 on macOS reports `memory`, so its web end-to-end job fails and is configured as continue-on-error. Driver destruction routes through idempotent `close()`.

See also [adapter](adapter.md) and [database](db.md).

## Full-text search availability

Node SQLite inherits the FTS5 capability. PostgreSQL inherits the tsvector and GIN capability.
SQLocal explicitly reports `search === undefined`.

Expo's bundled native SQLite enables FTS5 by default. Its config plugin can disable FTS with `enableFTS: false`.
`ExpoAdapter` checks `sqlite_compileoption_used('ENABLE_FTS5')` on the opened engine after applying any encryption key.
It inherits search when enabled and reports `search === undefined` otherwise.
This check uses the actual engine, including custom builds and SQLCipher configurations.
Native Expo search execution requires verification in the target application runtime.

See [optional full-text search](adapter.md#optional-full-text-search) for transaction, query syntax, ranking, prefix, and deletion semantics.
