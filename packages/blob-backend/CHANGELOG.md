# @hozon/blob-backend

## 0.2.0

### Minor Changes

- - Breaking: `BlobBackend` has a new required method `createStagingReadStream`, and an optional `listStaging`.
  - `commit` consumes its staging ID: later writes to that ID start an unrelated staging area.
  - Add the `BlobLock` type, `BlobLockTimeoutError`, and `createMemoryBlobLock`.

## 0.1.0

### Minor Changes

- Initial release.
