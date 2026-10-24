---
"@hozon/adapter": patch
"@hozon/conformance": patch
---

Array predicates treat a JSON value that is not an array (a scalar, an object or JSON null) as an empty array on both dialects. SQLite no longer matches a scalar equal to a candidate, and Postgres no longer fails the query when `includesAny` meets a scalar. Conformance gains a case for it.
