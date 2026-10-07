---
'@hozon/store-log': minor
'@hozon/store-telemetry': minor
---

Use logical table names so a custom `tablePrefix` applies; default physical names unchanged.

Databases created with a non-default `tablePrefix` must be reset because store tables move from `hozon_*` to `<prefix>_*`.
