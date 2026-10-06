# @hozon/node-sqlite

Node.js SQLite driver using the built-in `node:sqlite` module. Requires Node 24 or later.

```sh
pnpm add @hozon/node-sqlite @hozon/db
```

```ts
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: 'app.sqlite' }) })
```

See the [driver reference](../../docs/reference/drivers.md).
