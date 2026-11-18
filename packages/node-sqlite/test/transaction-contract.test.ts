import { HozonDB } from '@hozon/db'
import { describe, test } from 'vitest'

import { supportsCase } from '../../conformance/src/capabilities.js'
import { transactionContractCases } from '../../conformance/src/cases/transaction-contract.js'
import { NodeSQLiteAdapter } from '../src/index.js'

describe('node-sqlite transaction contract', () => {
  for (const entry of transactionContractCases) {
    test.skipIf(!supportsCase(entry))(entry.name, async () => {
      const adapter = new NodeSQLiteAdapter({ database: ':memory:' })
      const databases: Array<HozonDB> = []
      try {
        await entry.run({
          adapter,
          db: (params) => {
            const db = new HozonDB({ ...params, adapter })
            databases.push(db)
            return db
          },
        })
      } finally {
        for (const db of databases) await db.close()
        if (databases.length === 0) await adapter.close()
      }
    })
  }
})
