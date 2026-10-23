# @hozon/adapter

## 0.2.0

### Minor Changes

- Add the optional search capability and portable SearchCapability, SearchIndex, SearchEntry, SearchQuery, and SearchHit types. SQLite uses FTS5 and PostgreSQL uses tsvector with GIN. Search preserves caller transaction and table-prefix rules. SQLocal disables search and Expo detects native FTS5 support.

## 0.1.0

### Minor Changes

- Initial release.
