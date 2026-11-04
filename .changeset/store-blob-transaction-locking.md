---
"@hozon/store-blob": minor
---

Breaking: require `withBlobLocks` around entry, transfer, and deletion-journal mutations. Export `BLOB_LOCK_TABLE` and `withBlobLocks`. Add the `2-byte-deletions` migration and journal methods for durable byte cleanup without changing applied migrations.

Add migration `3-holders`, bounded ref and release APIs, remote state, and release tracking on creation, promotion, unpin and session completion or reset.

Add migration `4-fetch-sessions` with independent owner sessions and session chunk manifests. Replace the transfer API with bounded session operations, remove partial state, and replace chunk layouts on promotion.
