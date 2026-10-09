# @hozon/db

## 0.2.3

### Patch Changes

- Decode only known JSON columns in log and telemetry stores, preserving nested JSON-looking strings and plain text columns. Remove the global recursive JSON results parser from HozonDB. Custom stores must decode their own JSON columns when drivers return text.

  Update the JSON encoding conformance case to decode its known JSON column explicitly.

## 0.2.0

### Minor Changes

- Store tables honour `tablePrefix`; add `TablePrefixPlugin` and `MigrationContext.tablePrefix`.

## 0.1.0

### Minor Changes

- Initial release.
