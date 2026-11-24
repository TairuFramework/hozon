---
"@hozon/db": patch
---

Batch PostgreSQL key-lock admission into two SQL round trips regardless of key count, preserving the existing hash identities, signed acquisition order, transaction lifetime, and provider scope coordination.
