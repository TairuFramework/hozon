# @hozon/conformance

## 0.2.0

### Minor Changes

- Align with the breaking @hozon/db 0.4.0 and @hozon/adapter 0.2.0 releases.

- Exercise sync, search, savepoint loader invalidation, released-provider child hooks, and root SQL from scoped shutdown hooks through every portable driver harness.

- Updated dependencies:
  - @hozon/adapter@0.2.0
  - @hozon/db@0.4.0
  - @hozon/store-log@0.3.0
  - @hozon/store-telemetry@0.3.0

## 0.1.4

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.3.0

## 0.1.3

### Patch Changes

- Decode only known JSON columns in log and telemetry stores, preserving nested JSON-looking strings and plain text columns. Remove the global recursive JSON results parser from HozonDB. Custom stores must decode their own JSON columns when drivers return text.

  Update the JSON encoding conformance case to decode its known JSON column explicitly.

## 0.1.1

### Patch Changes

- Updated dependencies:
  - @hozon/db@0.2.0
  - @hozon/store-log@0.2.0
  - @hozon/store-telemetry@0.2.0

## 0.1.0

### Minor Changes

- Initial release.
