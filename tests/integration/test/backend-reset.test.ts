import { HozonDB } from '@hozon/db'
import { getLogStore, logStoreDefinition } from '@hozon/store-log'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

describe.each(backends())('$name conformance reset', (backend) => {
  afterEach(() => backend.cleanup())

  test('closes old adapters and removes case state before reusing the database', async () => {
    const db = new HozonDB({ adapter: await backend.createAdapter() })
    db.register(logStoreDefinition)
    const store = await getLogStore(db)
    await store.addLogs([
      { timestamp: 1, level: 'info', category: ['test'], message: 'old case', properties: {} },
    ])
    const location = backend.location()

    await backend.reset()
    await expect(store.queryLogs({ limit: 10 })).rejects.toThrow()

    const fresh = new HozonDB({ adapter: await backend.createAdapter() })
    if (backend.name === 'postgres') expect(backend.location()).toBe(location)
    fresh.register(logStoreDefinition)
    const freshStore = await getLogStore(fresh)
    expect((await freshStore.queryLogs({ limit: 10 })).logs).toEqual([])
    await freshStore.addLogs([
      { timestamp: 2, level: 'info', category: ['test'], message: 'new case', properties: {} },
    ])
    expect((await freshStore.queryLogs({ limit: 10 })).logs.map((log) => log.message)).toEqual([
      'new case',
    ])
    await fresh.close()
    await db.close()

    // Final cleanup still drops the reused database; a later test starts fresh.
    await backend.cleanup()
    const next = new HozonDB({ adapter: await backend.createAdapter() })
    expect(backend.location()).not.toBe(location)
    next.register(logStoreDefinition)
    expect((await (await getLogStore(next)).queryLogs({ limit: 10 })).logs).toEqual([])
    await next.close()
  })
})
