import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import { createMemoryBlobLock } from '@hozon/blob-backend'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TransferManifest } from '../src/index.js'
import {
  backendFactories,
  bytesOf,
  createTestService,
  listStaging,
  type TestService,
} from './helpers.js'

const CHUNK = 1024
const HOUR = 3_600_000

function split(bytes: Uint8Array): Array<Uint8Array> {
  const chunks: Array<Uint8Array> = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    chunks.push(bytes.slice(offset, offset + CHUNK))
  }
  return chunks
}

// Real ID and manifest for `bytes`, produced by a throwaway service.
async function sourceBlob(
  bytes: Uint8Array,
): Promise<{ id: string; manifest: TransferManifest; chunks: Array<Uint8Array> }> {
  const source = await createTestService({ chunkSize: CHUNK })
  try {
    const { entry } = await source.service.write(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    )
    return {
      id: entry.blobID,
      manifest: {
        contentLength: entry.contentLength,
        chunkSize: entry.chunkSize,
        chunks: await source.service.getChunkDigests(entry.blobID),
      },
      chunks: split(bytes),
    }
  } finally {
    await source.db.close()
  }
}

async function orphanStaging(backend: BlobBackend, stagingID: string): Promise<void> {
  const sink = await backend.createStaging(stagingID)
  const writer = sink.getWriter()
  await writer.write(bytesOf(10))
  await writer.close()
}

// Lock that runs a one-shot hook before acquiring the underlying lock.
function hookedLock(): { lock: BlobLock; arm(hook: () => Promise<void>): void } {
  const inner = createMemoryBlobLock()
  let hook: (() => Promise<void>) | null = null
  return {
    lock: {
      async withLock(id, fn) {
        const pending = hook
        hook = null
        await pending?.()
        return await inner.withLock(id, fn)
      },
    },
    arm(next) {
      hook = next
    },
  }
}

describe.each(backendFactories)('pruneStaging ($name)', (factory) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  let touchStaging: (stagingID: string, time: Date) => Promise<void>
  let ctx: TestService
  let hooked: ReturnType<typeof hookedLock>

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    ;({ backend, cleanup, touchStaging } = await factory.create())
    hooked = hookedLock()
    ctx = await createTestService({ backend, chunkSize: CHUNK, lock: hooked.lock })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await ctx.db.close()
    await cleanup()
  })

  test('removes an old orphan write staging and keeps a recent one', async () => {
    await orphanStaging(backend, 'w-old')
    vi.setSystemTime(Date.now() + 2 * HOUR)
    await orphanStaging(backend, 'w-new')
    await touchStaging('w-new', new Date())
    const result = await ctx.service.pruneStaging(new Date(Date.now() - HOUR))
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(await listStaging(backend)).toEqual(['w-new'])
  })

  test('keeps a write in progress even when olderThan is in the future', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const bytes = bytesOf(100)
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.slice(0, 50))
        await held
        controller.enqueue(bytes.slice(50))
        controller.close()
      },
    })
    const writing = ctx.service.write(stream)
    await vi.waitFor(async () => expect(await listStaging(backend)).toHaveLength(1))

    expect(await ctx.service.pruneStaging(new Date(Date.now() + HOUR))).toEqual({
      removed: 0,
      failed: 0,
    })
    expect(await listStaging(backend)).toHaveLength(1)

    release()
    const { entry } = await writing
    expect(entry.state).toBe('local')
    expect(await listStaging(backend)).toEqual([])
  })

  test('aborts an old transfer whose session is also old and resets the entry', async () => {
    const src = await sourceBlob(bytesOf(2500, 1))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)
    expect(await listStaging(backend)).toHaveLength(1)

    vi.setSystemTime(Date.now() + 2 * HOUR)
    const result = await ctx.service.pruneStaging(new Date(Date.now() - HOUR))
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(await listStaging(backend)).toEqual([])
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.store.getTransfer(src.id)).toBeNull()
  })

  test('keeps a transfer whose staging is old but whose session was touched recently', async () => {
    const src = await sourceBlob(bytesOf(2500, 2))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)

    vi.setSystemTime(Date.now() + 2 * HOUR)
    await ctx.service.beginFetch(src.id, src.manifest) // identical: touches the session
    const olderThan = new Date(Date.now() - HOUR)
    // The staging area is old for the FS backend; the session decides either way.
    expect(await ctx.service.pruneStaging(olderThan)).toEqual({ removed: 0, failed: 0 })
    expect(await listStaging(backend)).toHaveLength(1)
    expect((await ctx.service.get(src.id))?.state).toBe('partial')
  })

  test('skips a transfer touched between listing and locking', async () => {
    const src = await sourceBlob(bytesOf(2500, 3))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)

    vi.setSystemTime(Date.now() + 2 * HOUR)
    hooked.arm(async () => {
      await ctx.service.stageChunk(src.id, 1, src.chunks[1] as Uint8Array)
    })
    const result = await ctx.service.pruneStaging(new Date(Date.now() - HOUR))
    expect(result).toEqual({ removed: 0, failed: 0 })
    expect(await listStaging(backend)).toHaveLength(1)
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([0, 1])
  })

  test('leaves foreign-named staging areas untouched', async () => {
    await orphanStaging(backend, 'foreign')
    await orphanStaging(backend, 'w-old')
    vi.setSystemTime(Date.now() + 2 * HOUR)
    const result = await ctx.service.pruneStaging(new Date(Date.now() - HOUR))
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(await listStaging(backend)).toEqual(['foreign'])
  })

  test('counts a failing abort and still removes other areas', async () => {
    await orphanStaging(backend, 'w-bad')
    await orphanStaging(backend, 'w-good')
    vi.setSystemTime(Date.now() + 2 * HOUR)
    const flaky = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'abortStaging') {
          return async (stagingID: string) => {
            if (stagingID === 'w-bad') throw new Error('boom')
            await target.abortStaging(stagingID)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const other = await createTestService({ backend: flaky })
    try {
      expect(await other.service.pruneStaging(new Date(Date.now() - HOUR))).toEqual({
        removed: 1,
        failed: 1,
      })
      expect(await listStaging(backend)).toEqual(['w-bad'])
    } finally {
      await other.db.close()
    }
  })

  test('returns removed 0 for a backend without listStaging', async () => {
    await orphanStaging(backend, 'w-old')
    vi.setSystemTime(Date.now() + 2 * HOUR)
    const bare = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'listStaging') return undefined
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const other = await createTestService({ backend: bare })
    try {
      expect(await other.service.pruneStaging(new Date(Date.now() + HOUR))).toEqual({
        removed: 0,
        failed: 0,
      })
      expect(await listStaging(backend)).toEqual(['w-old'])
    } finally {
      await other.db.close()
    }
  })
})
