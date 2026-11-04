---
"@hozon/blob-backend": minor
---

Breaking: remove `BlobLock`, `createMemoryBlobLock`, and `BlobLockTimeoutError`. Blob services coordinate operations through database transactions and locks.
