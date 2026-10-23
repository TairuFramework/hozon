---
"@hozon/db": patch
---

Skip the migrator when every migration of a store is already applied, so opening an up-to-date store no longer starts a transaction. A second database over a single SQLite connection that is inside a transaction can now open its stores.
