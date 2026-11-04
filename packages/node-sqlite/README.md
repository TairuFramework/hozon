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

The adapter provides transaction context through Node's `AsyncLocalStorage`.
Root `withTransaction` calls inside an active caller transaction throw `TransactionScopeError`.
Use the supplied transaction provider, or a service view bound through `using(tx)`, inside the callback.
Unrelated concurrent calls queue normally. Context becomes inactive when the callback settles, including after rollback.

See the [driver reference](../../docs/reference/drivers.md).
