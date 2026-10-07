# @hozon/store-telemetry

Persistent OpenTelemetry span store with trace lookup, upsert, and retention.

```sh
pnpm add @hozon/store-telemetry @hozon/db
```

```ts
import { getTelemetryStore, telemetryStoreDefinition } from '@hozon/store-telemetry'

db.register(telemetryStoreDefinition)
const telemetry = await getTelemetryStore(db)
```

See the [store reference](../../docs/reference/stores/telemetry.md).
