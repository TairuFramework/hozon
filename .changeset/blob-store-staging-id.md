---
'@hozon/store-blob': minor
---

WARNING: migration `1-sessions` irreversibly resets existing `partial` entries to `remote-only` and drops their manifests and transfer progress.

- Add a `contentType` column and entry field.
- Add the `blob_transfer_sessions` table.
- Breaking: `beginTransfer(blobID, chunkSize, chunks, stagingID)` takes a `stagingID` parameter.
- Add `getTransfer`, `getTransferByStagingID`, `touchTransfer`, `listEntries`, `promoteEntry`, `resetTransfer`, and `fillContentType`.
