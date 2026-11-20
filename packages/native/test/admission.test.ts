import type { NativeSQLite } from '@hozon/adapter'
import { expect, test } from 'vitest'

import { NativeDriver } from '../src/driver.js'

for (const priority of [undefined, 'high', 'low'] as const) {
  test(`native driver passes ${priority ?? 'default'} priority to the host`, async () => {
    const options: Array<unknown> = []
    const sqlite: NativeSQLite = {
      open: async () => 'db',
      close: async () => {},
      abandon: async () => {},
      commit: async () => {},
      rollback: async () => {},
      execute: async () => ({ rows: [], columns: [], changes: 0n, lastInsertRowID: 0n }),
      beginWrite: (_db, input) => {
        options.push(input)
        return { admissionID: 'a', granted: Promise.resolve({ admissionID: 'a', txID: 't' }) }
      },
    }
    const driver = new NativeDriver({
      sqlite,
      database: Promise.resolve('db'),
      destroy: async () => {},
      priority,
    })
    const connection = await driver.acquireConnection()
    await driver.beginTransaction(connection)
    expect(options).toEqual([{ priority: priority ?? 'high', timeoutMs: undefined }])
    await driver.releaseConnection(connection)
  })
}
