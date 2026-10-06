import { HozonDBClosedError } from '@hozon/db'

import * as assert from '../assert.js'
import type { ConformanceCase } from '../runner.js'

export const lifecycleCases: Array<ConformanceCase> = [
  {
    name: 'lifecycle: close before first query',
    async run(ctx) {
      const db = ctx.db()
      await db.close()
      await assert.rejects(() => db.migrate(), HozonDBClosedError)
    },
  },
  {
    name: 'lifecycle: double close',
    async run(ctx) {
      const db = ctx.db()
      await db.migrate()
      await Promise.all([db.close(), db.close()])
      await db.close()
    },
  },
  {
    name: 'lifecycle: use after close rejects',
    async run(ctx) {
      const db = ctx.db()
      db.register({ name: 's', migrations: {}, createAPI: () => ({}) })
      await db.getStore('s')
      await db.close()
      await assert.rejects(() => db.getStore('s'), HozonDBClosedError)
      await assert.rejects(() => db.getStore('s'), 'HozonDB is closed')
      await assert.rejects(() => db.withTransaction(async () => {}), HozonDBClosedError)
      await assert.rejects(() => db.migrate(), HozonDBClosedError)
    },
  },
]
