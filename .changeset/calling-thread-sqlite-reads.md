---
"@hozon/adapter": minor
"@hozon/native": minor
---

Expose optional calling-thread autocommit SQLite reads through executeReadSync. Use a dedicated query-only WAL reader with immediate async fallback on contention, transaction rejection, and close/interrupt draining.
