# @hozon/db

Database lifecycle, store registration, migrations, transactions, and savepoints.

```sh
pnpm add @hozon/db @hozon/node-sqlite
```

```ts
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: 'app.sqlite' }) })
await db.migrate()
await db.close()
```

See the [database reference](../../docs/reference/db.md).
