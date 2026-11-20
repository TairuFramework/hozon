# @hozon/native

## 0.1.3

### Patch Changes

- Add optional high and low transaction priorities, defaulting to high. Native SQLite and Expo admit queued high writes first, preserving FIFO within priorities. Admit one waiting low write after eight consecutive high grants without preempting transactions.

## 0.1.2

### Patch Changes

- Refresh cached SQLite query columns after schema changes, including queries that return no rows.

## 0.1.1

### Patch Changes

- Expose a native write transaction to Rust callers. `Adapter.nativeTransactionOf` and `HozonDB.nativeTransaction` return the native database handle and txID of the active write transaction (shared by its savepoints), and `@hozon/native` implements them. Conformance gains a `nativeTransactions` capability with cases for shared writes and rejection after commit or rollback. The Rust engine now binds up to SQLite's per-connection variable limit instead of 500 parameters.

## 0.1.0

### Minor Changes

- Add the native SQLite contract and explicit admission expiry policy. Expose transaction loader invalidation, extend native conformance coverage, and introduce the injected Rust SQLite adapter at 0.1.0.

### Patch Changes

- Updated dependencies:
  - @hozon/adapter@0.3.1
