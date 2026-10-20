import type { BlobStoreAPI } from '@hozon/store-blob'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { getFreshEntry } from '../src/fresh.js'
import { bytesOf, createTestService, sourceOf, type TestService } from './helpers.js'

let ctx: TestService

beforeEach(async () => {
  ctx = await createTestService({ chunkSize: 4096 })
})
afterEach(async () => {
  await ctx.db.close()
})

test('getFreshEntry ignores remembered values in a scope', async () => {
  const { entry } = await ctx.service.write({ stream: sourceOf(bytesOf(10)).stream })
  await ctx.db.withScope<{ blob: BlobStoreAPI }, void>(async (scope) => {
    const scoped = await scope.getStore('blob')
    expect((await scoped.getEntry(entry.blobID))?.pinned).toBe(false)
    await ctx.store.setPinned(entry.blobID, true)
    expect((await scoped.getEntry(entry.blobID))?.pinned).toBe(false)
    expect((await getFreshEntry(scoped, entry.blobID))?.pinned).toBe(true)
    expect(await getFreshEntry(scoped, 'missing')).toBeNull()
  })
})
