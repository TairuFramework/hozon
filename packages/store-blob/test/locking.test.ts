import { BatchLimitError, HozonDB } from '@hozon/db'
import { NodeSQLiteAdapter } from '@hozon/node-sqlite'
import { expect, test } from 'vitest'

import { blobStoreDefinition, getBlobStore, withBlobLocks } from '../src/index.js'

test('locks use the scoped provider and journal entries survive without an entry', async () => {
  const db = new HozonDB({ adapter: new NodeSQLiteAdapter({ database: ':memory:' }) })
  db.register(blobStoreDefinition)
  try {
    await withBlobLocks(db, ['b', 'a', 'a'], async (tx) => {
      expect(tx.isTransactionBound).toBe(true)
      const store = await getBlobStore(tx)
      await store.enqueueByteDeletion('a', 10)
      await store.enqueueByteDeletion('b', 5)
      await store.enqueueByteDeletion('a', 20)
      expect(await store.listByteDeletions({ limit: 1 })).toEqual([{ blobID: 'b', queuedAt: 5 }])
      await withBlobLocks(tx, ['a'], async (locked) => {
        await (await getBlobStore(locked)).deleteByteDeletion('a')
      })
    })
    expect(await (await getBlobStore(db)).listByteDeletions()).toEqual([
      { blobID: 'b', queuedAt: 5 },
    ])
    await expect(
      withBlobLocks(
        db,
        Array.from({ length: 501 }, (_, i) => String(i)),
        async () => {},
      ),
    ).rejects.toBeInstanceOf(BatchLimitError)
    await expect(
      withBlobLocks(db, ['b'], async (tx) => {
        await (await getBlobStore(tx)).deleteByteDeletion('b')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await (await getBlobStore(db)).listByteDeletions()).toHaveLength(1)
  } finally {
    await db.close()
  }
})
