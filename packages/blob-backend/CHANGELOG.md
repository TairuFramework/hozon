# @hozon/blob-backend

## 0.3.0

### Minor Changes

- Breaking: remove `BlobLock`, `createMemoryBlobLock`, and `BlobLockTimeoutError`. Blob services coordinate operations through database transactions and locks.

  Add optional committed-key enumeration through `listKeys`, implemented by the memory backend with publication times.

  Specify stable staging bytes until re-written, committed, or aborted, including identical verified re-stages.

## 0.2.0

### Minor Changes

- - Breaking: `BlobBackend` has a new required method `createStagingReadStream`, and an optional `listStaging`.
  - `commit` consumes its staging ID: later writes to that ID start an unrelated staging area.
  - Add the `BlobLock` type, `BlobLockTimeoutError`, and `createMemoryBlobLock`.

## 0.1.0

### Minor Changes

- Initial release.
