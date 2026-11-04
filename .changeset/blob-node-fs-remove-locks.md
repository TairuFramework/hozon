---
"@hozon/blob-node-fs": minor
---

Breaking: remove `createFileBlobLock` and `FileBlobLockParams`. Blob services coordinate operations through database transactions and locks.

Enumerate committed keys with filesystem modification times through `listKeys`, excluding staging.

Document staging stability for in-place filesystem writes, with shared memory and filesystem contract coverage.
