# Architecture

## Packages

Hozon provides database adapters, a database and store registry, persistent stores, and telemetry integrations. Packages use ESM and publish from their package entry points.

## Dependency graph

- `@hozon/adapter` is the shared base for all drivers.
- `@hozon/db` uses the adapter contract. The two stores build on the database package.
- `@hozon/provider` resolves `@hozon/db`, `@hozon/node-sqlite`, and `@hozon/postgres`.
- `@hozon/logtape` builds on `@hozon/store-log`; `@hozon/otel` builds on `@hozon/store-telemetry`.
- `@hozon/conformance` exercises the adapter, database, and both stores.
- `@hozon/expo` and `@hozon/sqlocal` provide platform-specific SQLite drivers.


`@hozon/provider` resolves Node database inputs. Expo and SQLocal are platform-specific drivers.
`@hozon/conformance` exports reusable cases and an optional Vitest entry point.

## Adapter and store model

An adapter supplies a Kysely dialect, column types, value encoders, and query predicates. Drivers own their native connections and close them through `HozonDB.close()`.

A store registers migrations and a `createAPI` function with `HozonDB`. Stores use fixed `hozon_` table names. The configurable table prefix applies to migration and savepoint names only.

Stores decode known JSON columns once when a driver returns text. `HozonDB` leaves driver results untouched, preserving nested strings and plain text columns.

`HozonDB` checks registered store schemas before driver preparation and migrations. SQLite migrations run transactionally; a failed migration rolls back and can retry on the next open. A store method that needs atomicity uses `withStoreTransaction`. Store methods must not call `.transaction()` directly.

## Preflight order

On the first `migrate()`, `getStore()`, or `withTransaction()`, Hozon checks registered migration versions, calls the adapter's optional `prepare()`, then runs migrations. A version mismatch fails before preparation or writes. A store registered later is checked before its own migrations.

## Test tiers

- Unit tests cover package logic and in-memory SQLite without Docker or files.
- Integration tests exercise file-backed SQLite and PostgreSQL across drivers, stores, and telemetry integrations.
- Web, Electron, and Expo end-to-end harnesses run conformance and store scenarios in platform runtimes.

See [development](development.md), [adapter reference](../reference/adapter.md), and [driver reference](../reference/drivers.md).
