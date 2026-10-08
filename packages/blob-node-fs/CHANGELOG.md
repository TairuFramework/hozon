# @hozon/blob-node-fs

## 0.2.0

### Minor Changes

- - Implement `createStagingReadStream` and `listStaging` for the new `BlobBackend` contract.
  - Add `createFileBlobLock`, a cross-process `BlobLock` for processes on one host.
  - Fix a race between staging abort and close.

### Patch Changes

- Updated dependencies:
  - @hozon/blob-backend@0.2.0

## 0.1.0

### Minor Changes

- Initial release.
