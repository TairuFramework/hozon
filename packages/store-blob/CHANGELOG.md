# @hozon/store-blob

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
