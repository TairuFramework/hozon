# @hozon/node-sqlite

## 0.3.1

### Patch Changes

- Return statement metadata beyond JavaScript's safe integer range as bigint. Previously a row ID above 2^53 made `run()` throw `ERR_OUT_OF_RANGE`, and because SQLite keeps the connection's last-insert row ID, every later statement on that connection, `BEGIN` included, threw as well. Safe values are still returned as numbers.

## 0.3.0

### Minor Changes

- Expose the optional adapter transaction-context contract. Provide transaction context through Node's `AsyncLocalStorage` for single-connection transaction-scope detection. Reject root transaction calls inside active caller transactions while preserving transaction-bound calls, unrelated concurrent queueing, and fresh transactions after settlement.

### Patch Changes

- Updated dependencies:
  - @hozon/adapter@0.3.0

## 0.2.0

### Minor Changes

- Align with the breaking @hozon/db 0.4.0 and @hozon/adapter 0.2.0 releases.

- Updated dependencies:
  - @hozon/adapter@0.2.0

## 0.1.0

### Minor Changes

- Initial release.
