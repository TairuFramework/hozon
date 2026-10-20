---
"@hozon/db": minor
---

Add batch loader, load scopes, store context and batch read primitives.

`StoreDefinition.createAPI` now receives a third `context: StoreContext` argument. Code that calls a definition's `createAPI(db, adapter)` directly must pass a `StoreContext`.
