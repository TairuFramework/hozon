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
type ExpoAdapterParams = { database: string }
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

`ExpoAdapter({ database })` opens an Expo SQLite database and enables foreign keys. Booleans serialize as `1` or `0`; dates serialize as ISO strings.

Hermes cannot compile Kysely's `FileMigrationProvider` because its dynamic import uses a variable path (kysely#1628, imported through `kysely/migration`). Wrap the Metro config with `withHozonMetroConfig` from `@hozon/expo/metro`. See the [Expo README](../../packages/expo/README.md).

## SQLocal

`SQLocalAdapter({ database })` requires browser cross-origin isolation headers (`COOP` and `COEP`) and OPFS. Verify `sqlocal.getDatabaseInfo().storageType` is `opfs` when persistence matters. Playwright WebKit 26.6 on macOS reports `memory`, so its web end-to-end job fails and is configured as continue-on-error. Driver destruction routes through idempotent `close()`.

See also [adapter](adapter.md) and [database](db.md).
