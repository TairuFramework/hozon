---
'@hozon/adapter': patch
'@hozon/db': patch
'@hozon/conformance': patch
'@hozon/native': patch
---

Expose a native write transaction to Rust callers. `Adapter.nativeTransactionOf` and `HozonDB.nativeTransaction` return the native database handle and txID of the active write transaction (shared by its savepoints), and `@hozon/native` implements them. Conformance gains a `nativeTransactions` capability with cases for shared writes and rejection after commit or rollback. The Rust engine now binds up to SQLite's per-connection variable limit instead of 500 parameters.
