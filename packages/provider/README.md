# @hozon/provider

Resolve a Node adapter or database from an adapter instance, SQLite path, or PostgreSQL URL.

```sh
pnpm add @hozon/provider
```

```ts
import { resolveDB } from '@hozon/provider'

const db = resolveDB(':memory:')
```

See the [driver reference](../../docs/reference/drivers.md).
