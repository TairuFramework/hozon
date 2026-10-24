# @hozon/store-telemetry

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

## 0.2.3

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.3.0

## 0.2.2

### Patch Changes

- Decode only known JSON columns in log and telemetry stores, preserving nested JSON-looking strings and plain text columns. Remove the global recursive JSON results parser from HozonDB. Custom stores must decode their own JSON columns when drivers return text.

  Update the JSON encoding conformance case to decode its known JSON column explicitly.

## 0.2.0

### Minor Changes

- Use logical table names so a custom `tablePrefix` applies; default physical names unchanged.

  Databases created with a non-default `tablePrefix` must be reset because store tables move from `hozon_*` to `<prefix>_*`.

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.2.0

## 0.1.0

### Minor Changes

- Initial release.
