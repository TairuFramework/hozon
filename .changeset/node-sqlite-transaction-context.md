---
"@hozon/node-sqlite": minor
"@hozon/adapter": minor
---

Expose the optional adapter transaction-context contract. Provide transaction context through Node's `AsyncLocalStorage` for single-connection transaction-scope detection. Reject root transaction calls inside active caller transactions while preserving transaction-bound calls, unrelated concurrent queueing, and fresh transactions after settlement.
