// Child process for concurrency.test.ts: `node --experimental-strip-types writer.ts <path> <n>`
// appends n logs to the node:sqlite file at <path>, one write transaction per log.
import { HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { getLogStore, logStoreDefinition } from '@hozon/store-log'

const [path, count] = process.argv.slice(2)
if (path === undefined || count === undefined) {
  throw new Error('Usage: writer.ts <path> <count>')
}

const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: path }) })
try {
  db.register(logStoreDefinition)
  const store = await getLogStore(db)
  for (let index = 0; index < Number(count); index++) {
    await store.addLogs([
      {
        timestamp: Date.now(),
        level: 'info',
        category: ['writer', String(process.pid)],
        message: `log ${index}`,
        properties: { index },
      },
    ])
  }
} finally {
  await db.close()
}
