---
name: database
description: Use when working with HozonDB, StoreDefinition, tablePrefix, TablePrefixPlugin, blob stores, store registration, migrations, transactions, or savepoints.
---

# Hozon database

Use these references for the database runtime API and its lifecycle rules. They are the source of truth; do not duplicate their details here.

## Store table prefixes

`tablePrefix` applies to store tables and migration tables.
`@hozon/db` exports `TablePrefixPlugin`.
Use logical, unprefixed table names in store APIs, migrations, and table type keys.
Use `ctx.tablePrefix` for index and constraint names.
WARNING: never reference system tables through the store instance.
The plugin prefixes unqualified table names.

## References

- Database runtime, store registration, migrations, transactions, and savepoints: `../../../../docs/reference/db.md`
- Adapter contract used by HozonDB: `../../../../docs/reference/adapter.md`
- Store APIs and transaction behaviour: `../../../../docs/reference/stores.md`
- Package entry points and examples: `../../../../packages/db/README.md`
