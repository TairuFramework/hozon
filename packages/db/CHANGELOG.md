# @hozon/db

## 0.5.0

### Minor Changes

- Throw the exported StoreAlreadyRegisteredError when a different definition object registers under an existing store name. Re-registering the same object remains a no-op. Packages depending on `@hozon/db`, directly or through another hozon package, take a minor bump with it, so a consumer updating them moves to the breaking `@hozon/db` deliberately.

### Patch Changes

- Skip the migrator when every migration of a store is already applied, so opening an up-to-date store no longer starts a transaction. A second database over a single SQLite connection that is inside a transaction can now open its stores.

## 0.4.0

### Minor Changes

- BREAKING: StoreProvider.isTransactionBound is required. StoreContext gains provider, root, onClose, and compareWrite. Savepoints get distinct store APIs and loaders. Transaction-scoped getStore rejects once close starts. Settled savepoint providers, their derived lock-scoped providers, and bound context operations throw SavepointReleasedError. Store API objects are not guarded. Plain queries through their captured Kysely execute in the still-open outer transaction after savepoint release or rollback. chunk uses iterable semantics, so sparse holes become undefined. Successful savepoint release invalidates remembered loader results registry-wide.

  Add a context factory for HozonDB context extensions, onClose shutdown hooks, transactionRoot identity, withKeyLock/withKeyLocks/KeyLockScopeError, compareWrite/compareText merge policies, and chunk unique support with IN_LIST_CHUNK. Shutdown hooks run outside transactions and use root store APIs obtained before close for SQL.

### Patch Changes

- Updated dependencies:
  - @hozon/adapter@0.2.0

## 0.3.0

### Minor Changes

- Add batch loader, load scopes, store context and batch read primitives.

  `StoreDefinition.createAPI` now receives a third `context: StoreContext` argument. Code that calls a definition's `createAPI(db, adapter)` directly must pass a `StoreContext`.

## 0.2.3

### Patch Changes

- Decode only known JSON columns in log and telemetry stores, preserving nested JSON-looking strings and plain text columns. Remove the global recursive JSON results parser from HozonDB. Custom stores must decode their own JSON columns when drivers return text.

  Update the JSON encoding conformance case to decode its known JSON column explicitly.

## 0.2.0

### Minor Changes

- Store tables honour `tablePrefix`; add `TablePrefixPlugin` and `MigrationContext.tablePrefix`.

## 0.1.0

### Minor Changes

- Initial release.
