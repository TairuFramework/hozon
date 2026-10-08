---
'@hozon/blob-node-fs': minor
---

- Implement `createStagingReadStream` and `listStaging` for the new `BlobBackend` contract.
- Add `createFileBlobLock`, a cross-process `BlobLock` for processes on one host.
- Fix a race between staging abort and close.
