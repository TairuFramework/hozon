# Adapter

`@hozon/adapter` defines the common SQLite and PostgreSQL adapter contract. The package entry exports `AbstractSQLiteAdapter`, `AbstractPostgresAdapter`, `SQLiteTypes`, `PostgresTypes`, `AbstractAdapter`, `Adapter`, `AdapterTypes`, `ColumnTypes`, `Functions`, `OrderDirection`, `NullOrderingTerm`, `ArrayPresenceMode`, `CreatedAtColumn`, and `UpdatedAtColumn`.

Adapters provide `kind`, `dialect`, `functions`, `types`, value encoders and decoders, `coerceFilterValue`, numeric casts, null ordering, `containsPredicate`, array inclusion and array presence predicates. The optional `prepare()` and `close()` hooks support connection setup and teardown.

`containsPredicate` accepts a SQL `LIKE` pattern, such as `%needle%`. Array inclusion predicates bind one parameter per value. Hozon's own statements stay within the 500-parameter limit, but callers must chunk large value lists passed to these predicates.

See [drivers](drivers.md) for concrete adapters and [database lifecycle](db.md) for preparation order.
