---
"@hozon/blob": minor
---

Breaking: remove the configurable blob lock. Coordinate mutations through database transaction locks and bind caller transactions with `using(provider)` and lock-scoped `withLocks` views. Add durable deletion replay through `drainByteDeletions`, rollback byte reclaim, shared staging protection, writes-only `maxStagingBytes`, and bounded PostgreSQL deadlock retry for service-owned transactions.

Run locked metadata statements before final byte publication, preserving intact staging across statement-deadlock retries. Retain prepared writes across `writeWith` attempts and preserve the original error when retry bytes no longer exist. Cleanup uses the lifetime-independent provider root and a dependency-free logger contract.

Add opaque holder refs, release-based collection, referenced-delete protection with force, remote eviction, byte reconciliation, and one-shot maintenance. Remote fetches require the verified chunk size and digests.

Add independent per-owner fetch sessions, abort by owner or owner prefix, transfer pagination, and staging limits including fetch sessions. Remove partial state. Accept remote fetch manifests at another chunk size and replace the verified layout on completion.
