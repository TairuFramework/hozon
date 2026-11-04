import type { BlobBackend } from '@hozon/blob-backend'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { BlobNotFoundError } from '../src/index.js'
import { deferred, gatedBackend } from './gated-backend.js'
import {
  backendFactories,
  bytesOf,
  createTestService,
  listStaging,
  sourceOf,
  type TestService,
} from './helpers.js'

describe.each(backendFactories)('manage ($name)', (factory) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  let ctx: TestService

  beforeEach(async () => {
    ;({ backend, cleanup } = await factory.create())
    ctx = await createTestService({ backend, chunkSize: 4096 })
  })
  afterEach(async () => {
    await ctx.db.close()
    await cleanup()
  })

  test('setPinned toggles and rejects unknown IDs', async () => {
    const { entry } = await ctx.service.write({ stream: sourceOf(bytesOf(10)).stream })
    await ctx.service.setPinned(entry.blobID, true)
    expect((await ctx.service.get(entry.blobID))?.pinned).toBe(true)
    await ctx.service.setPinned(entry.blobID, false)
    expect((await ctx.service.get(entry.blobID))?.pinned).toBe(false)
    const unknown = ctx.service.codec.encode({ digest: new Uint8Array(32), contentLength: 1 })
    await expect(ctx.service.setPinned(unknown, true)).rejects.toThrow(BlobNotFoundError)
  })

  test('delete removes row, manifest and bytes', async () => {
    const { entry } = await ctx.service.write({ stream: sourceOf(bytesOf(5000)).stream })
    const id = entry.blobID
    expect(await ctx.service.delete(id)).toBe(true)
    expect(await ctx.store.getEntry(id)).toBeNull()
    expect(await ctx.store.getChunkDigests(id)).toEqual([])
    expect(await backend.has(id)).toBe(false)
    expect(await ctx.service.delete(id)).toBe(false)
  })

  test('delete aborts the staging area of a partial entry', async () => {
    const id = ctx.service.codec.encode({ digest: new Uint8Array(32).fill(3), contentLength: 10 })
    await ctx.store.insertEntry(
      { blobID: id, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    await ctx.store.beginTransfer({ blobID: id, chunkSize: 4, chunks: [], stagingID: 'stg-del' })
    await backend.writeChunk('stg-del', 0, bytesOf(4))
    expect(await listStaging(backend)).toEqual(['stg-del'])
    expect(await ctx.service.delete(id)).toBe(true)
    expect(await ctx.store.getEntry(id)).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  // Forces the lock order of one write and one delete of the same blob.
  describe.each(['write-first', 'delete-first'] as const)(
    'concurrent write and delete (%s)',
    (order) => {
      test('row present iff bytes present, in the forced order', async () => {
        const data = bytesOf(5000)
        let sawPresent = 0
        let sawAbsent = 0
        for (let i = 0; i < 10; i++) {
          const gate = gatedBackend(backend)
          const built = await createTestService({ backend: gate.backend, chunkSize: 4096 })
          try {
            const id = (await built.service.write({ stream: sourceOf(data).stream })).entry.blobID
            if (order === 'write-first') {
              const entered = deferred()
              const release = deferred()
              const first = built.service.withLocks([id], async (ops) => {
                await ops.write({ stream: sourceOf(data, 500).stream })
                entered.resolve()
                await release.promise
              })
              await entered.promise
              const second = built.service.delete(id)
              release.resolve()
              await first
              await second
            } else {
              const parked = gate.park('delete')
              const first = built.service.delete(id)
              await parked.entered
              const second = built.service.write({ stream: sourceOf(data, 500).stream })
              parked.release()
              await Promise.all([first, second])
            }
            const row = (await built.store.getEntry(id)) !== null
            expect(row).toBe(await backend.has(id))
            expect(row).toBe(order === 'delete-first')
            if (row) sawPresent++
            else sawAbsent++
            await built.service.delete(id)
          } finally {
            await built.db.close()
          }
        }
        expect(order === 'delete-first' ? sawPresent : sawAbsent).toBe(10)
      }, 30_000)
    },
  )
})
