# @hozon/sqlocal

Browser SQLite adapter backed by SQLocal and OPFS.

```sh
pnpm add @hozon/sqlocal @hozon/db sqlocal
```

```ts
import { HozonDB } from '@hozon/db'
import { SQLocalAdapter } from '@hozon/sqlocal'

const db = new HozonDB({ adapter: new SQLocalAdapter({ database: 'app.sqlite3' }) })
```

Serve with COOP and COEP headers and confirm OPFS is available. See the [driver reference](../../docs/reference/drivers.md).
