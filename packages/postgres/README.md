# @hozon/postgres

PostgreSQL driver backed by postgres.js and Kysely. Requires Node 24 or later.

```sh
pnpm add @hozon/postgres @hozon/db
```

```ts
import { HozonDB } from '@hozon/db'
import { PostgresAdapter } from '@hozon/postgres'

const db = new HozonDB({ adapter: new PostgresAdapter({ url: process.env.DATABASE_URL! }) })
```

See the [driver reference](../../docs/reference/drivers.md).
