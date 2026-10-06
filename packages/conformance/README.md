# @hozon/conformance

Runner-agnostic adapter, database, and store conformance cases, with an optional Vitest suite entry.

```sh
pnpm add @hozon/conformance
```

```ts
import { defineVitestSuite } from '@hozon/conformance/vitest'

defineVitestSuite({ name: 'SQLite', createAdapter })
```

The core entry exports `allCases`, individual case arrays, `runConformance`, and `summarize`. See the [architecture](../../docs/agents/architecture.md).
