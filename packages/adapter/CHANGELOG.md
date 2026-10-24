# @hozon/adapter

## 0.2.1

### Patch Changes

- Array predicates treat a JSON value that is not an array (a scalar, an object or JSON null) as an empty array on both dialects. SQLite no longer matches a scalar equal to a candidate, and Postgres no longer fails the query when `includesAny` meets a scalar. Conformance gains a case for it.

## 0.2.0

### Minor Changes

- Add the optional search capability and portable SearchCapability, SearchIndex, SearchEntry, SearchQuery, and SearchHit types. SQLite uses FTS5 and PostgreSQL uses tsvector with GIN. Search preserves caller transaction and table-prefix rules. SQLocal disables search and Expo detects native FTS5 support.

## 0.1.0

### Minor Changes

- Initial release.
