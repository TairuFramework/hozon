---
"@hozon/blob-backend": minor
---

Breaking: remove `BlobLock`, `createMemoryBlobLock`, and `BlobLockTimeoutError`. Blob services coordinate operations through database transactions and locks.

Add optional committed-key enumeration through `listKeys`, implemented by the memory backend with publication times.
