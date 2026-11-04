---
"@hozon/db": patch
---

Throw `TransactionScopeError` when a root transaction starts inside its active caller transaction on single-connection SQLite. Detect caller context through optional adapter-provided transaction context without runtime probing or platform imports, while preserving unrelated concurrent queueing and transaction-bound nesting.

Expose optional `StoreProvider.root` identity across scopes, transactions, savepoints, and lock-derived providers so cleanup can open fresh transactions after settlement.
