---
"@hozon/db": minor
"@hozon/blob": minor
"@hozon/conformance": minor
"@hozon/logtape": minor
"@hozon/otel": minor
"@hozon/provider": minor
"@hozon/store-blob": minor
"@hozon/store-log": minor
"@hozon/store-telemetry": minor
---

Throw the exported StoreAlreadyRegisteredError when a different definition object registers under an existing store name. Re-registering the same object remains a no-op. Packages depending on `@hozon/db`, directly or through another hozon package, take a minor bump with it, so a consumer updating them moves to the breaking `@hozon/db` deliberately.
