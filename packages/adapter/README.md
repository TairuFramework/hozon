# @hozon/adapter

Shared adapter contract and dialect helpers for Hozon's SQLite and PostgreSQL drivers.

```sh
pnpm add @hozon/adapter
```

Import `Adapter` when defining a driver contract:

```ts
import type { Adapter } from '@hozon/adapter'

type DriverContract = Adapter
```

See the [adapter reference](../../docs/reference/adapter.md).
