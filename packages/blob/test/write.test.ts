import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import { createMemoryBlobLock } from '@hozon/blob-backend'
import { blake3Codec, hashStream } from '@hozon/blob-id'
import { getBlobStore } from '@hozon/store-blob'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  BlobIDMismatchError,
  BlobTooLargeError,
  BlobWriteAbortedError,
  ContentTypeMismatchError,
  createBlobService,
} from '../src/index.js'
import {
  backendFactories,
  bytesOf,
  createTestService,
  digestOf,
  listStaging,
  mimeCodec,
  sourceOf,
  type TestService,
} from './helpers.js'

async function hashChunks(bytes: Uint8Array, chunkSize: number): Promise<Array<Uint8Array>> {
  const { transform, result } = hashStream(blake3Codec, chunkSize)
  await sourceOf(bytes).stream.pipeThrough(transform).pipeTo(new WritableStream())
  return (await result).chunks
}

function idOf(bytes: Uint8Array): string {
  return blake3Codec.encode({ digest: digestOf(bytes), contentLength: bytes.length })
}

describe('createBlobService', () => {
  test('validates chunkSize and limits', async () => {
    const { db, backend } = await createTestService()
    expect(() => createBlobService({ db, backend, chunkSize: 512 })).toThrow('Invalid chunkSize')
    expect(() => createBlobService({ db, backend, chunkSize: 1.5 })).toThrow('Invalid chunkSize')
    expect(() =>
      createBlobService({ db, backend, limits: { minChunkSize: 4096, maxChunkSize: 1024 } }),
    ).toThrow('Invalid limits')
    expect(() => createBlobService({ db, backend, limits: { maxBlobSize: -1 } })).toThrow(
      'Invalid limits',
    )
    await db.close()
  })
})

describe.each(backendFactories)('write ($name)', (factory) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  let ctx: TestService
  const opened: Array<TestService> = []

  async function build(params: Parameters<typeof createTestService>[0] = {}) {
    const built = await createTestService({ backend, chunkSize: 4096, ...params })
    opened.push(built)
    return built
  }

  beforeEach(async () => {
    ;({ backend, cleanup } = await factory.create())
    ctx = await build()
  })
  afterEach(async () => {
    for (const item of opened.splice(0)) await item.db.close()
    await cleanup()
  })

  test('writes a blob and records its manifest', async () => {
    const data = bytesOf(10)
    const { entry, created } = await ctx.service.write(sourceOf(data).stream)
    expect(created).toBe(true)
    expect(entry.blobID).toBe(idOf(data))
    expect(entry).toMatchObject({
      contentLength: 10,
      state: 'local',
      chunkSize: 4096,
      contentType: null,
      encrypted: false,
      keyID: null,
    })
    expect(await ctx.store.getChunkDigests(entry.blobID)).toEqual(await hashChunks(data, 4096))
    expect(await backend.has(entry.blobID)).toBe(true)
    expect(await listStaging(backend)).toEqual([])
  })

  test('records multiple chunks with a short final chunk', async () => {
    const built = await build({ chunkSize: 1024 })
    const data = bytesOf(2500)
    const { entry } = await built.service.write(sourceOf(data, 700).stream)
    const digests = await built.store.getChunkDigests(entry.blobID)
    expect(digests).toHaveLength(3)
    expect(digests).toEqual(await hashChunks(data, 1024))
  })

  test('writes a zero-length blob with zero chunks', async () => {
    const { entry, created } = await ctx.service.write(sourceOf(new Uint8Array(0)).stream)
    expect(created).toBe(true)
    expect(entry.contentLength).toBe(0)
    expect(entry.blobID).toBe(idOf(new Uint8Array(0)))
    expect(await ctx.store.getChunkDigests(entry.blobID)).toEqual([])
    expect(await backend.has(entry.blobID)).toBe(true)
  })

  test('records encryption metadata as given', async () => {
    const { entry } = await ctx.service.write(sourceOf(bytesOf(5)).stream, {
      encrypted: true,
      keyID: 'k1',
      contentType: 'text/plain',
    })
    expect(entry).toMatchObject({ encrypted: true, keyID: 'k1', contentType: 'text/plain' })
  })

  test('a second identical write returns the existing entry', async () => {
    const data = bytesOf(10)
    const first = await ctx.service.write(sourceOf(data).stream)
    const second = await ctx.service.write(sourceOf(data).stream, { encrypted: true })
    expect(second.created).toBe(false)
    expect(second.entry).toEqual(first.entry)
    expect(await listStaging(backend)).toEqual([])
  })

  test('fills a null content type only', async () => {
    const data = bytesOf(10)
    await ctx.service.write(sourceOf(data).stream)
    const second = await ctx.service.write(sourceOf(data).stream, { contentType: 'image/png' })
    expect(second.entry.contentType).toBe('image/png')
    const third = await ctx.service.write(sourceOf(data).stream, { contentType: 'text/plain' })
    expect(third.entry.contentType).toBe('image/png')
    expect((await ctx.store.getEntry(idOf(data)))?.contentType).toBe('image/png')
  })

  test('maxSize bounds the stream', async () => {
    const data = bytesOf(10)
    await expect(ctx.service.write(sourceOf(data).stream, { maxSize: 4 })).rejects.toBeInstanceOf(
      BlobTooLargeError,
    )
    expect(await ctx.store.getEntry(idOf(data))).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('limits.maxBlobSize bounds the stream', async () => {
    const built = await build({ limits: { maxBlobSize: 4 } })
    const data = bytesOf(10)
    await expect(built.service.write(sourceOf(data).stream, { maxSize: 100 })).rejects.toThrow(
      BlobTooLargeError,
    )
    expect(await built.store.getEntry(idOf(data))).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('a content length equal to the limit is accepted', async () => {
    const { created } = await ctx.service.write(sourceOf(bytesOf(10)).stream, { maxSize: 10 })
    expect(created).toBe(true)
  })

  test('expectedID mismatch commits nothing', async () => {
    const data = bytesOf(10)
    await expect(
      ctx.service.write(sourceOf(data).stream, { expectedID: idOf(bytesOf(10, 1)) }),
    ).rejects.toBeInstanceOf(BlobIDMismatchError)
    expect(await ctx.store.getEntry(idOf(data))).toBeNull()
    expect(await backend.has(idOf(data))).toBe(false)
    expect(await listStaging(backend)).toEqual([])
  })

  test('uppercase expectedID of the same bytes succeeds', async () => {
    const data = bytesOf(10)
    const { entry } = await ctx.service.write(sourceOf(data).stream, {
      expectedID: idOf(data).toUpperCase(),
    })
    expect(entry.blobID).toBe(idOf(data))
  })

  test('expectedID above the size limit is rejected before reading', async () => {
    const source = sourceOf(bytesOf(10))
    const expectedID = blake3Codec.encode({ digest: new Uint8Array(32), contentLength: 100 })
    await expect(
      ctx.service.write(source.stream, { expectedID, maxSize: 4 }),
    ).rejects.toBeInstanceOf(BlobTooLargeError)
    expect(source.pulls()).toBe(0)
    expect(await listStaging(backend)).toEqual([])
  })

  describe('with a content-type embedding codec', () => {
    test('the expectedID content type is stored when the request has none', async () => {
      const built = await build({ codec: mimeCodec })
      const data = bytesOf(10)
      const expectedID = mimeCodec.encode({
        digest: digestOf(data),
        contentLength: 10,
        contentType: 'image/png',
      })
      const { entry } = await built.service.write(sourceOf(data).stream, { expectedID })
      expect(entry.blobID).toBe(expectedID)
      expect(entry.contentType).toBe('image/png')
    })

    test('a different request content type is rejected before reading', async () => {
      const built = await build({ codec: mimeCodec })
      const data = bytesOf(10)
      const source = sourceOf(data)
      const expectedID = mimeCodec.encode({
        digest: digestOf(data),
        contentLength: 10,
        contentType: 'image/png',
      })
      await expect(
        built.service.write(source.stream, { expectedID, contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(ContentTypeMismatchError)
      expect(source.pulls()).toBe(0)
      expect(await listStaging(backend)).toEqual([])
    })
  })

  test('a source error aborts staging and records nothing', async () => {
    const failure = new Error('source failed')
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(bytesOf(3))
        else controller.error(failure)
      },
    })
    await expect(ctx.service.write(stream)).rejects.toBe(failure)
    expect((await ctx.store.listEntries({ limit: 10 })).entries).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('rejects an invalid maxSize before staging', async () => {
    for (const maxSize of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const { stream, pulls } = sourceOf(bytesOf(10))
      await expect(ctx.service.write(stream, { maxSize })).rejects.toThrow('Invalid maxSize')
      expect(pulls()).toBe(0)
    }
    expect(await listStaging(backend)).toEqual([])
  })

  test('an abort mid-stream throws BlobWriteAbortedError', async () => {
    const controller = new AbortController()
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(source) {
        if (pulls++ === 1) controller.abort()
        source.enqueue(bytesOf(3))
      },
    })
    await expect(ctx.service.write(stream, { signal: controller.signal })).rejects.toBeInstanceOf(
      BlobWriteAbortedError,
    )
    expect((await ctx.store.listEntries({ limit: 10 })).entries).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('an abort after the stream ends never publishes', async () => {
    const controller = new AbortController()
    const base = createMemoryBlobLock()
    const lock: BlobLock = {
      withLock(id, fn) {
        controller.abort()
        return base.withLock(id, fn)
      },
    }
    const built = await build({ lock })
    const data = bytesOf(10)
    await expect(
      built.service.write(sourceOf(data).stream, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(BlobWriteAbortedError)
    expect(await backend.has(idOf(data))).toBe(false)
    expect(await built.store.getEntry(idOf(data))).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('promotes a partial entry and discards its transfer staging', async () => {
    const data = bytesOf(10)
    const id = idOf(data)
    await ctx.store.insertEntry(
      { blobID: id, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
      [],
    )
    const chunks = [0, 1, 2].map((index) => ({ index, digest: new Uint8Array(32) }))
    await ctx.store.beginTransfer(id, 4, chunks, 'stg-transfer')
    await backend.writeChunk('stg-transfer', 0, data.subarray(0, 4))
    await ctx.store.recordTransferChunk(id, 0)

    const { entry, created } = await ctx.service.write(sourceOf(data).stream)
    expect(created).toBe(true)
    expect(entry).toMatchObject({ blobID: id, state: 'local', chunkSize: 4096, createdAt: 5 })
    expect(await ctx.store.getChunkDigests(id)).toEqual(await hashChunks(data, 4096))
    expect(await ctx.store.getTransfer(id)).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  describe('writeWith', () => {
    test('runs fn in the transaction that records the entry', async () => {
      const data = bytesOf(10)
      const { entry, created, result } = await ctx.service.writeWith(
        sourceOf(data).stream,
        {},
        async (tx, recorded) => {
          const seen = await (await getBlobStore(tx)).getEntry(recorded.blobID)
          return seen
        },
      )
      expect(created).toBe(true)
      expect(result).toEqual(entry)
      expect(result?.state).toBe('local')
    })

    test('runs fn for an already-local blob', async () => {
      const data = bytesOf(10)
      await ctx.service.write(sourceOf(data).stream)
      const { entry, created, result } = await ctx.service.writeWith(
        sourceOf(data).stream,
        { contentType: 'image/png' },
        async (_tx, existing) => existing.contentType,
      )
      expect(created).toBe(false)
      expect(entry.contentType).toBe('image/png')
      expect(result).toBe('image/png')
    })

    test('rolls back the entry when fn throws', async () => {
      const data = bytesOf(10)
      const failure = new Error('fn failed')
      await expect(
        ctx.service.writeWith(sourceOf(data).stream, {}, async () => {
          throw failure
        }),
      ).rejects.toBe(failure)
      expect(await ctx.store.getEntry(idOf(data))).toBeNull()
    })

    test('keeps a partial transfer when fn throws', async () => {
      const data = bytesOf(10)
      const id = idOf(data)
      await ctx.store.insertEntry(
        { blobID: id, contentLength: 10, chunkSize: 4, state: 'remote-only', createdAt: 5 },
        [],
      )
      await ctx.store.beginTransfer(id, 4, [], 'stg-transfer')
      await backend.writeChunk('stg-transfer', 0, data.subarray(0, 4))
      await expect(
        ctx.service.writeWith(sourceOf(data).stream, {}, async () => {
          throw new Error('fn failed')
        }),
      ).rejects.toThrow('fn failed')
      expect((await ctx.store.getEntry(id))?.state).toBe('partial')
      expect(await listStaging(backend)).toEqual(['stg-transfer'])
    })

    test('a concurrent locked mutation waits for writeWith to commit', async () => {
      const data = bytesOf(10)
      const id = idOf(data)
      const events: Array<string> = []
      let concurrent: Promise<void> | undefined
      const write = ctx.service.writeWith(sourceOf(data).stream, {}, async (tx) => {
        events.push('fn-start')
        tx.onCommit(() => events.push('commit'))
        concurrent = ctx.service.delete(id).then(() => {
          events.push('delete-end')
        })
        for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 1))
        events.push('fn-end')
      })
      await write
      await concurrent
      expect(events).toEqual(['fn-start', 'fn-end', 'commit', 'delete-end'])
      expect(await ctx.store.getEntry(id)).toBeNull()
    })
  })
})
