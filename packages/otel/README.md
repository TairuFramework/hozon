# @hozon/otel

OpenTelemetry span exporter that writes spans to an `@hozon/store-telemetry` store.

```sh
pnpm add @hozon/otel @opentelemetry/api @opentelemetry/sdk-trace-base @hozon/store-telemetry
```

```ts
import { createTelemetrySpanExporter } from '@hozon/otel'

const exporter = createTelemetrySpanExporter(telemetryStore)
```

See the [telemetry reference](../../docs/reference/telemetry.md).
