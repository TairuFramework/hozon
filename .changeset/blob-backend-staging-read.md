---
'@hozon/blob-backend': minor
---

- Breaking: `BlobBackend` has a new required method `createStagingReadStream`, and an optional `listStaging`.
- `commit` consumes its staging ID: later writes to that ID start an unrelated staging area.
- Add the `BlobLock` type, `BlobLockTimeoutError`, and `createMemoryBlobLock`.
