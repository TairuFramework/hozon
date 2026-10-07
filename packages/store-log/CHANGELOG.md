# @hozon/store-log

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
