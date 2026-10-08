import type { BlobBackend } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { TransferManifest } from '../src/index.js'
import {
  BlobIDMismatchError,
  BlobNotFoundError,
  ChunkDigestMismatchError,
  ChunkLengthError,
  createBlobService,
  InvalidManifestError,
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

const CHUNK = 1024

type Source = {
  id: string
  bytes: Uint8Array
  manifest: TransferManifest
  chunks: Array<Uint8Array>
}

function split(bytes: Uint8Array, chunkSize: number): Array<Uint8Array> {
  const chunks: Array<Uint8Array> = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize))
  }
  return chunks
}

// Writes `bytes` with a source service to obtain a real ID and manifest.
async function sourceBlob(
  bytes: Uint8Array,
  params: { chunkSize?: number; codec?: BlobIDCodec; contentType?: string } = {},
): Promise<Source> {
  const chunkSize = params.chunkSize ?? CHUNK
  const source = await createTestService({ chunkSize, codec: params.codec })
  try {
    const { entry } = await source.service.write(
      sourceOf(bytes, 100).stream,
      params.contentType === undefined ? {} : { contentType: params.contentType },
    )
    const manifest: TransferManifest = {
      contentLength: entry.contentLength,
      chunkSize: entry.chunkSize,
      chunks: await source.service.getChunkDigests(entry.blobID),
      ...(entry.contentType === null ? {} : { contentType: entry.contentType }),
    }
    return { id: entry.blobID, bytes, manifest, chunks: split(bytes, chunkSize) }
  } finally {
    await source.db.close()
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Array<Uint8Array> = []
  for await (const part of stream) parts.push(part)
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe.each(backendFactories)('transfer ($name)', (factory) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  let ctx: TestService

  beforeEach(async () => {
    ;({ backend, cleanup } = await factory.create())
    ctx = await createTestService({ backend, chunkSize: CHUNK })
  })
  afterEach(async () => {
    await ctx.db.close()
    await cleanup()
  })

  test.each([2500, 2048])('happy path, %i bytes, chunks staged in reverse', async (length) => {
    const src = await sourceBlob(bytesOf(length, 5), { contentType: 'text/plain' })
    await ctx.service.beginFetch(src.id.toUpperCase(), src.manifest)
    expect((await ctx.service.get(src.id))?.state).toBe('partial')
    for (let index = src.chunks.length - 1; index >= 0; index--) {
      await ctx.service.stageChunk(src.id.toUpperCase(), index, src.chunks[index] as Uint8Array)
    }
    expect(await ctx.service.getPresentChunks(src.id)).toEqual(src.chunks.map((_, i) => i))
    const entry = await ctx.service.completeFetch(src.id.toUpperCase())
    expect(entry).toMatchObject({
      blobID: src.id,
      state: 'local',
      contentLength: length,
      chunkSize: CHUNK,
      contentType: 'text/plain',
    })
    expect(await readAll(await ctx.service.createReadStream(src.id))).toEqual(src.bytes)
    expect(await ctx.service.getChunkDigests(src.id)).toEqual(src.manifest.chunks)
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([])
    expect(await ctx.store.getTransfer(src.id)).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('beginFetch on a local blob is a no-op', async () => {
    const src = await sourceBlob(bytesOf(2500))
    await ctx.service.write(sourceOf(src.bytes, 100).stream)
    await ctx.service.beginFetch(src.id, src.manifest)
    expect((await ctx.service.get(src.id))?.state).toBe('local')
    expect(await ctx.store.getTransfer(src.id)).toBeNull()
  })

  test('identical manifest keeps the session; a different one resets progress', async () => {
    const bytes = bytesOf(4096, 9)
    const src = await sourceBlob(bytes)
    await ctx.service.beginFetch(src.id, src.manifest)
    const first = await ctx.store.getTransfer(src.id)
    expect(first?.stagingID).toMatch(/^t-[0-9a-f]{32}$/)
    await ctx.service.stageChunk(src.id, 1, src.chunks[1] as Uint8Array)

    await ctx.service.beginFetch(src.id, { ...src.manifest, chunks: [...src.manifest.chunks] })
    const second = await ctx.store.getTransfer(src.id)
    expect(second?.stagingID).toBe(first?.stagingID)
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([1])

    const other = await sourceBlob(bytes, { chunkSize: 2048 })
    expect(other.id).toBe(src.id)
    await ctx.service.beginFetch(src.id, other.manifest)
    const third = await ctx.store.getTransfer(src.id)
    expect(third?.stagingID).not.toBe(first?.stagingID)
    expect(third?.presentChunks).toEqual([])
    expect((await ctx.service.get(src.id))?.chunkSize).toBe(2048)
    expect(await listStaging(backend)).toEqual([])

    for (const [index, chunk] of other.chunks.entries()) {
      await ctx.service.stageChunk(src.id, index, chunk)
    }
    await ctx.service.completeFetch(src.id)
    expect(await readAll(await ctx.service.createReadStream(src.id))).toEqual(bytes)
  })

  describe('invalid manifests', () => {
    let src: Source
    beforeEach(async () => {
      src = await sourceBlob(bytesOf(2500, 1))
    })

    const cases: Array<[string, (manifest: TransferManifest) => TransferManifest]> = [
      ['chunk count one short', (m) => ({ ...m, chunks: m.chunks.slice(1) })],
      ['chunk count one over', (m) => ({ ...m, chunks: [...m.chunks, m.chunks[0] as Uint8Array] })],
      [
        'digest of 31 bytes',
        (m) => ({
          ...m,
          chunks: [m.chunks[0] as Uint8Array, new Uint8Array(31), m.chunks[2] as Uint8Array],
        }),
      ],
      [
        'chunkSize below minimum',
        (m) => ({ ...m, chunkSize: 512, chunks: new Array(5).fill(m.chunks[0]) }),
      ],
      [
        'chunkSize above maximum',
        (m) => ({ ...m, chunkSize: 32 * 1024 * 1024, chunks: [m.chunks[0] as Uint8Array] }),
      ],
      ['non-integer chunkSize', (m) => ({ ...m, chunkSize: 1024.5 })],
      ['contentLength not matching the ID', (m) => ({ ...m, contentLength: 2501 })],
      ['negative contentLength', (m) => ({ ...m, contentLength: -1 })],
    ]

    test.each(cases)('%s', async (_, mutate) => {
      await expect(ctx.service.beginFetch(src.id, mutate(src.manifest))).rejects.toThrow(
        InvalidManifestError,
      )
      expect(await ctx.store.getEntry(src.id)).toBeNull()
      expect(await ctx.store.getTransfer(src.id)).toBeNull()
    })

    test('contentLength above maxBlobSize', async () => {
      const small = await createTestService({
        backend,
        chunkSize: CHUNK,
        limits: { maxBlobSize: 2000 },
      })
      try {
        await expect(small.service.beginFetch(src.id, src.manifest)).rejects.toThrow(
          InvalidManifestError,
        )
        expect(await small.store.getEntry(src.id)).toBeNull()
      } finally {
        await small.db.close()
      }
    })

    test('MIME-embedding codec with a conflicting contentType', async () => {
      const mime = await sourceBlob(bytesOf(2500, 1), {
        codec: mimeCodec,
        contentType: 'text/plain',
      })
      const dest = await createTestService({ backend, chunkSize: CHUNK, codec: mimeCodec })
      try {
        await expect(
          dest.service.beginFetch(mime.id, { ...mime.manifest, contentType: 'image/png' }),
        ).rejects.toThrow(InvalidManifestError)
        expect(await dest.store.getEntry(mime.id)).toBeNull()

        // An omitted contentType takes the one embedded in the ID.
        const { contentType: _, ...withoutType } = mime.manifest
        await dest.service.beginFetch(mime.id, withoutType)
        for (const [index, chunk] of mime.chunks.entries()) {
          await dest.service.stageChunk(mime.id, index, chunk)
        }
        expect((await dest.service.completeFetch(mime.id)).contentType).toBe('text/plain')
      } finally {
        await dest.db.close()
      }
    })
  })

  test('zero-length blob', async () => {
    const src = await sourceBlob(new Uint8Array(0))
    expect(src.manifest.chunks).toEqual([])
    await ctx.service.beginFetch(src.id, src.manifest)
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([])
    const entry = await ctx.service.completeFetch(src.id)
    expect(entry).toMatchObject({ state: 'local', contentLength: 0 })
    expect(await readAll(await ctx.service.createReadStream(src.id))).toEqual(new Uint8Array(0))
    expect(await listStaging(backend)).toEqual([])
  })

  test('stageChunk rejects bad input without recording anything', async () => {
    const src = await sourceBlob(bytesOf(2500, 2))
    await ctx.service.beginFetch(src.id, src.manifest)
    const [c0, c1, c2] = src.chunks as [Uint8Array, Uint8Array, Uint8Array]

    for (const index of [-1, 3, 1.5]) {
      await expect(ctx.service.stageChunk(src.id, index, c0)).rejects.toThrow(InvalidManifestError)
    }
    const padded = new Uint8Array(CHUNK)
    padded.set(c2)
    await expect(ctx.service.stageChunk(src.id, 2, padded)).rejects.toThrow(ChunkLengthError)
    await expect(ctx.service.stageChunk(src.id, 1, c1.slice(0, 1000))).rejects.toThrow(
      ChunkLengthError,
    )
    const tampered = c1.slice()
    tampered[10] = (tampered[10] as number) ^ 0xff
    await expect(ctx.service.stageChunk(src.id, 1, tampered)).rejects.toThrow(
      ChunkDigestMismatchError,
    )

    expect(await ctx.service.getPresentChunks(src.id)).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('stageChunk and completeFetch without an active transfer throw BlobNotFoundError', async () => {
    const src = await sourceBlob(bytesOf(2500, 3))
    await expect(ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)).rejects.toThrow(
      BlobNotFoundError,
    )
    await expect(ctx.service.completeFetch(src.id)).rejects.toThrow(BlobNotFoundError)
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([])
  })

  test('completeFetch with a missing chunk leaves the transfer intact', async () => {
    const src = await sourceBlob(bytesOf(2500, 4))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)
    await ctx.service.stageChunk(src.id, 2, src.chunks[2] as Uint8Array)
    await expect(ctx.service.completeFetch(src.id)).rejects.toThrow(/missing/)
    expect((await ctx.service.get(src.id))?.state).toBe('partial')
    expect(await ctx.service.getPresentChunks(src.id)).toEqual([0, 2])
    expect(await backend.has(src.id)).toBe(false)

    await ctx.service.stageChunk(src.id, 1, src.chunks[1] as Uint8Array)
    expect((await ctx.service.completeFetch(src.id)).state).toBe('local')
  })

  test('whole-blob mismatch publishes nothing and resets the transfer', async () => {
    const src = await sourceBlob(bytesOf(2500, 6))
    const tampered = src.bytes.slice()
    tampered[1500] = (tampered[1500] as number) ^ 0xff
    const tamperedChunks = split(tampered, CHUNK)
    await ctx.service.beginFetch(src.id, { ...src.manifest, chunks: tamperedChunks.map(digestOf) })
    for (const [index, chunk] of tamperedChunks.entries()) {
      await ctx.service.stageChunk(src.id, index, chunk)
    }
    await expect(ctx.service.completeFetch(src.id)).rejects.toThrow(BlobIDMismatchError)
    expect(await backend.has(src.id)).toBe(false)
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.store.getTransfer(src.id)).toBeNull()
    expect(await ctx.store.getChunkDigests(src.id)).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('resume across service instances, and a vanished staging area resets', async () => {
    const src = await sourceBlob(bytesOf(2500, 7))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)
    await ctx.service.stageChunk(src.id, 1, src.chunks[1] as Uint8Array)

    const resumed = createBlobService({ db: ctx.db, backend, chunkSize: CHUNK })
    expect(await resumed.getPresentChunks(src.id)).toEqual([0, 1])

    const transfer = await ctx.store.getTransfer(src.id)
    await backend.abortStaging(transfer?.stagingID as string)
    expect(await resumed.getPresentChunks(src.id)).toEqual([])
    expect((await resumed.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.store.getTransfer(src.id)).toBeNull()

    // The caller begins again and completes.
    await resumed.beginFetch(src.id, src.manifest)
    for (const [index, chunk] of src.chunks.entries())
      await resumed.stageChunk(src.id, index, chunk)
    expect((await resumed.completeFetch(src.id)).state).toBe('local')
  })

  test('identical beginFetch after the staging area vanished starts a fresh session', async () => {
    const src = await sourceBlob(bytesOf(2500, 8))
    await ctx.service.beginFetch(src.id, src.manifest)
    await ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)
    const first = await ctx.store.getTransfer(src.id)
    await backend.abortStaging(first?.stagingID as string)
    await ctx.service.beginFetch(src.id, src.manifest)
    const second = await ctx.store.getTransfer(src.id)
    expect(second?.stagingID).not.toBe(first?.stagingID)
    expect(second?.presentChunks).toEqual([])
  })

  test('stageChunk queued behind completeFetch is rejected', async () => {
    const src = await sourceBlob(bytesOf(2500, 10))
    await ctx.service.beginFetch(src.id, src.manifest)
    for (const [index, chunk] of src.chunks.entries())
      await ctx.service.stageChunk(src.id, index, chunk)
    const done = ctx.service.completeFetch(src.id)
    const late = ctx.service.stageChunk(src.id, 0, src.chunks[0] as Uint8Array)
    await expect(late).rejects.toThrow(BlobNotFoundError)
    expect((await done).state).toBe('local')
    expect(await listStaging(backend)).toEqual([])
  })
})
