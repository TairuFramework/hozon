---
"@hozon/blob-node-fs": minor
---

Breaking: remove `createFileBlobLock` and `FileBlobLockParams`. Blob services coordinate operations through database transactions and locks.
