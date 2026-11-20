# @hozon/expo

## 0.2.3

### Patch Changes

- Add optional high and low transaction priorities, defaulting to high. Native SQLite and Expo admit queued high writes first, preserving FIFO within priorities. Admit one waiting low write after eight consecutive high grants without preempting transactions.

## 0.2.2

### Patch Changes

- `ExpoDriver.destroy` waits for the connection holder before closing, so a running transaction does not fail on a closed handle.

## 0.2.1

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
