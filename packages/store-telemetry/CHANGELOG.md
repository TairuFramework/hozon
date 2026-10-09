# @hozon/store-telemetry

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
