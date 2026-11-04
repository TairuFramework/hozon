# @hozon/store-blob

## 0.5.0

### Minor Changes

- Breaking: require `withBlobLocks` around entry, transfer, and deletion-journal mutations. Export `BLOB_LOCK_TABLE` and `withBlobLocks`. Add the `2-byte-deletions` migration and journal methods for durable byte cleanup without changing applied migrations.

  Add migration `3-holders`, bounded ref and release APIs, remote state, and release tracking on creation, promotion, unpin and session completion or reset.

  Add migration `4-fetch-sessions` with independent owner sessions and session chunk manifests. Replace the transfer API with bounded session operations, remove partial state, and replace chunk layouts on promotion.

### Patch Changes

- Updated dependencies:
  - @hozon/adapter@0.3.0

## 0.4.0

### Minor Changes

- Throw the exported StoreAlreadyRegisteredError when a different definition object registers under an existing store name. Re-registering the same object remains a no-op. Packages depending on `@hozon/db`, directly or through another hozon package, take a minor bump with it, so a consumer updating them moves to the breaking `@hozon/db` deliberately.

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.5.0

## 0.3.0

### Minor Changes

- Align with the breaking @hozon/db 0.4.0 and @hozon/adapter 0.2.0 releases.

- Updated dependencies:
  - @hozon/adapter@0.2.0
  - @hozon/db@0.4.0

## 0.2.2

### Patch Changes

- Add getEntries and batch getEntry reads.

- Updated dependencies:
  - @hozon/db@0.3.0

## 0.2.0

### Minor Changes

- WARNING: migration `1-sessions` irreversibly resets existing `partial` entries to `remote-only` and drops their manifests and transfer progress.

  - Add a `contentType` column and entry field.
  - Add the `blob_transfer_sessions` table.
  - Breaking: `beginTransfer` takes a single `BeginTransferParams` object, which includes a `stagingID`.
  - Add `getTransfer`, `getTransferByStagingID`, `touchTransfer`, `listEntries`, `promoteEntry`, `resetTransfer`, and `fillContentType`.

## 0.1.0

### Minor Changes

- Initial release.

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.2.0
