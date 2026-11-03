# @hozon/blob

## 0.4.0

### Minor Changes

- Breaking: blob IDs now start with the codec's multicodec code, so another hash can coexist under a new code. `blake3Codec` encodes `varint(0x1e) || varint(contentLength) || BLAKE3-256 digest` and `decode` rejects any other leading code. `BlobIDCodec` gains a required `code` field. IDs from earlier versions no longer decode.

### Patch Changes

- Updated dependencies:
  - @hozon/blob-id@0.2.0

## 0.3.0

### Minor Changes

- Throw the exported StoreAlreadyRegisteredError when a different definition object registers under an existing store name. Re-registering the same object remains a no-op. Packages depending on `@hozon/db`, directly or through another hozon package, take a minor bump with it, so a consumer updating them moves to the breaking `@hozon/db` deliberately.

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.5.0
  - @hozon/store-blob@0.4.0

## 0.2.0

### Minor Changes

- Align with the breaking @hozon/db 0.4.0 and @hozon/adapter 0.2.0 releases.

- Updated dependencies:
  - @hozon/db@0.4.0
  - @hozon/store-blob@0.3.0

## 0.1.1

### Patch Changes

- Read entries fresh under the blob lock.

- Updated dependencies:
  - @hozon/db@0.3.0

## 0.1.0

### Minor Changes

- Initial release.

### Patch Changes

- Updated dependencies:
  - @hozon/blob-backend@0.2.0
  - @hozon/store-blob@0.2.0
