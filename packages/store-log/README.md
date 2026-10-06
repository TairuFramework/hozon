# @hozon/store-log

Persistent structured log store with chronological queries, trace lookup, and retention.

```sh
pnpm add @hozon/store-log @hozon/db
```

```ts
import { getLogStore, logStoreDefinition } from '@hozon/store-log'

db.register(logStoreDefinition)
const logs = await getLogStore(db)
await logs.addLogs([])
```

See the [store reference](../../docs/reference/stores.md).
