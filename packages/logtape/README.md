# @hozon/logtape

LogTape sink that batches records into an `@hozon/store-log` store.

```sh
pnpm add @hozon/logtape @logtape/logtape @opentelemetry/api @hozon/store-log
```

```ts
import { createLogStoreSink } from '@hozon/logtape'

const sink = createLogStoreSink(logStore)
```

See the [telemetry reference](../../docs/reference/telemetry.md).
