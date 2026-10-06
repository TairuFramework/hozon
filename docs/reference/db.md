# Database

`@hozon/db` exports `HozonDB`, `HozonDBParams`, `MigrationContext`, `StoreDefinition`, and `StoreProvider`. It also exports `HozonDBClosedError`, `InvalidTablePrefixError`, `SavepointOverlapError`, `SchemaVersionError`, `chunk`, `withKeepSet`, and `withStoreTransaction`.

Create a database with an adapter, register store definitions, then request a store or call `migrate()`:

```ts
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { logStoreDefinition, getLogStore } from '@hozon/store-log'

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: 'app.sqlite' }) })
db.register(logStoreDefinition)
const logs = await getLogStore(db)
await db.close()
```

The default migration prefix is `hozon`, validated against `^[a-z][a-z0-9_]{0,30}$`. Migration tables are `<prefix>_<store>_migration` and `<prefix>_<store>_migration_lock`; savepoints use `<prefix>_sp_N`. Stores use fixed table names and cannot be duplicated by changing this prefix.

Preflight checks schema versions before adapter preparation and migrations. Every SQLite dialect is wrapped so migrations run in a transaction. A failed migration rolls back and retries on the next open. There is no per-driver opt-out. `withTransaction` passes a scoped provider to the callback. Store methods needing atomicity use `withStoreTransaction`; they do not call `.transaction()` directly.
