import type { BlobBackend } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { TransferManifest } from '../src/index.js'
import {
  BlobIDMismatchError,
  BlobNotFoundError,
  ChunkDigestMismatchError,
  ChunkLengthError,
  createBlobService,
  InvalidManifestError,
  TransferIncompleteError,
} from '../src/index.js'
import { gatedBackend } from './gated-backend.js'
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
    const { entry } = await source.service.write({
      stream: sourceOf(bytes, 100).stream,
      ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
    })
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
    await ctx.service.beginFetch({
      id: src.id.toUpperCase(),
      owner: 'owner-a',
      manifest: src.manifest,
    })
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
    for (let index = src.chunks.length - 1; index >= 0; index--) {
      await ctx.service.stageChunk({
        owner: 'owner-a',
        id: src.id.toUpperCase(),
        index,
        bytes: src.chunks[index] as Uint8Array,
      })
    }
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual(
      src.chunks.map((_, i) => i),
    )
    const entry = await ctx.service
      .completeFetch({ id: src.id.toUpperCase(), owner: 'owner-a' })
      .then((result) => result.entry)
    expect(entry).toMatchObject({
      blobID: src.id,
      state: 'local',
      contentLength: length,
      chunkSize: CHUNK,
      contentType: 'text/plain',
    })
    expect(await readAll(await ctx.service.createReadStream(src.id))).toEqual(src.bytes)
    expect(await ctx.service.getChunkDigests(src.id)).toEqual(src.manifest.chunks)
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([])
    expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
    expect(await listStaging(backend)).toEqual([])
  })

  test('beginFetch on a local blob is a no-op', async () => {
    const src = await sourceBlob(bytesOf(2500))
    await ctx.service.write({ stream: sourceOf(src.bytes, 100).stream })
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    expect((await ctx.service.get(src.id))?.state).toBe('local')
    expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
  })

  test('identical manifest keeps the session; a different one resets progress', async () => {
    const bytes = bytesOf(4096, 9)
    const src = await sourceBlob(bytes)
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    const first = await ctx.store.getSession(src.id, 'owner-a')
    expect(first?.stagingID).toMatch(/^t-[0-9a-f]{32}$/)
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 1,
      bytes: src.chunks[1] as Uint8Array,
    })

    await ctx.service.beginFetch({
      id: src.id,
      owner: 'owner-a',
      manifest: { ...src.manifest, chunks: [...src.manifest.chunks] },
    })
    const second = await ctx.store.getSession(src.id, 'owner-a')
    expect(second?.stagingID).toBe(first?.stagingID)
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([1])

    const other = await sourceBlob(bytes, { chunkSize: 2048 })
    expect(other.id).toBe(src.id)
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: other.manifest })
    const third = await ctx.store.getSession(src.id, 'owner-a')
    expect(third?.stagingID).not.toBe(first?.stagingID)
    expect(third?.presentChunks).toEqual([])
    expect(third?.chunkSize).toBe(2048)
    expect(await listStaging(backend)).toEqual([])

    for (const [index, chunk] of other.chunks.entries()) {
      await ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index, bytes: chunk })
    }
    await ctx.service.completeFetch({ id: src.id, owner: 'owner-a' }).then((result) => result.entry)
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
      await expect(
        ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: mutate(src.manifest) }),
      ).rejects.toThrow(InvalidManifestError)
      expect(await ctx.store.getEntry(src.id)).toBeNull()
      expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
    })

    test('remote-only stub with a different contentLength', async () => {
      await ctx.store.insertEntry(
        {
          blobID: src.id,
          contentLength: 2501,
          chunkSize: CHUNK,
          state: 'remote-only',
          createdAt: 5,
        },
        [],
      )
      await expect(
        ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest }),
      ).rejects.toThrow(InvalidManifestError)
      expect((await ctx.store.getEntry(src.id))?.state).toBe('remote-only')
      expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
    })

    test('contentLength above maxBlobSize', async () => {
      const small = await createTestService({
        backend,
        chunkSize: CHUNK,
        limits: { maxBlobSize: 2000 },
      })
      try {
        await expect(
          small.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest }),
        ).rejects.toThrow(InvalidManifestError)
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
          dest.service.beginFetch({
            id: mime.id,
            owner: 'owner-a',
            manifest: { ...mime.manifest, contentType: 'image/png' },
          }),
        ).rejects.toThrow(InvalidManifestError)
        expect(await dest.store.getEntry(mime.id)).toBeNull()

        // An omitted contentType takes the one embedded in the ID.
        const { contentType: _, ...withoutType } = mime.manifest
        await dest.service.beginFetch({ id: mime.id, owner: 'owner-a', manifest: withoutType })
        for (const [index, chunk] of mime.chunks.entries()) {
          await dest.service.stageChunk({ owner: 'owner-a', id: mime.id, index, bytes: chunk })
        }
        expect(
          (
            await dest.service
              .completeFetch({ id: mime.id, owner: 'owner-a' })
              .then((result) => result.entry)
          ).contentType,
        ).toBe('text/plain')
      } finally {
        await dest.db.close()
      }
    })
  })

  test('zero-length blob', async () => {
    const src = await sourceBlob(new Uint8Array(0))
    expect(src.manifest.chunks).toEqual([])
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([])
    const entry = await ctx.service
      .completeFetch({ id: src.id, owner: 'owner-a' })
      .then((result) => result.entry)
    expect(entry).toMatchObject({ state: 'local', contentLength: 0 })
    expect(await readAll(await ctx.service.createReadStream(src.id))).toEqual(new Uint8Array(0))
    expect(await listStaging(backend)).toEqual([])
  })

  test('stageChunk rejects bad input without recording anything', async () => {
    const src = await sourceBlob(bytesOf(2500, 2))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    const [c0, c1, c2] = src.chunks as [Uint8Array, Uint8Array, Uint8Array]

    for (const index of [-1, 3, 1.5]) {
      await expect(
        ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index, bytes: c0 }),
      ).rejects.toThrow(InvalidManifestError)
    }
    const padded = new Uint8Array(CHUNK)
    padded.set(c2)
    await expect(
      ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index: 2, bytes: padded }),
    ).rejects.toThrow(ChunkLengthError)
    await expect(
      ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index: 1, bytes: c1.slice(0, 1000) }),
    ).rejects.toThrow(ChunkLengthError)
    const tampered = c1.slice()
    tampered[10] = (tampered[10] as number) ^ 0xff
    await expect(
      ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index: 1, bytes: tampered }),
    ).rejects.toThrow(ChunkDigestMismatchError)

    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('beginFetch rejects ill-typed metadata', async () => {
    const src = await sourceBlob(bytesOf(2500, 11))
    const bad = [
      { contentType: 5 },
      { contentType: 'x'.repeat(256) },
      { encrypted: 'yes' },
      { keyID: 7 },
      { keyID: 'k'.repeat(256) },
    ]
    for (const extra of bad) {
      await expect(
        ctx.service.beginFetch({
          id: src.id,
          owner: 'owner-a',
          manifest: {
            ...src.manifest,
            ...extra,
          } as unknown as TransferManifest,
        }),
      ).rejects.toThrow(InvalidManifestError)
    }
    expect(await ctx.service.get(src.id)).toBeNull()
    await ctx.service.beginFetch({
      id: src.id,
      owner: 'owner-a',
      manifest: {
        ...src.manifest,
        contentType: 'x'.repeat(255),
        encrypted: true,
        keyID: 'k'.repeat(255),
      },
    })
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
  })

  test('zero-length transfer records the service chunk size, not the peer one', async () => {
    const src = await sourceBlob(new Uint8Array(0))
    await ctx.service.beginFetch({
      id: src.id,
      owner: 'owner-a',
      manifest: { ...src.manifest, chunkSize: 7 },
    })
    const entry = await ctx.service
      .completeFetch({ id: src.id, owner: 'owner-a' })
      .then((result) => result.entry)
    expect(entry.chunkSize).toBe(CHUNK)
  })

  test('stageChunk and completeFetch without an active transfer throw BlobNotFoundError', async () => {
    const src = await sourceBlob(bytesOf(2500, 3))
    await expect(
      ctx.service.stageChunk({
        owner: 'owner-a',
        id: src.id,
        index: 0,
        bytes: src.chunks[0] as Uint8Array,
      }),
    ).rejects.toThrow(BlobNotFoundError)
    await expect(
      ctx.service.completeFetch({ id: src.id, owner: 'owner-a' }).then((result) => result.entry),
    ).rejects.toThrow(BlobNotFoundError)
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([])
  })

  test('completeFetch with a missing chunk leaves the transfer intact', async () => {
    const src = await sourceBlob(bytesOf(2500, 4))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 0,
      bytes: src.chunks[0] as Uint8Array,
    })
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 2,
      bytes: src.chunks[2] as Uint8Array,
    })
    await expect(
      ctx.service.completeFetch({ id: src.id, owner: 'owner-a' }).then((result) => result.entry),
    ).rejects.toThrow(TransferIncompleteError)
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.service.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([0, 2])
    expect(await backend.has(src.id)).toBe(false)

    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 1,
      bytes: src.chunks[1] as Uint8Array,
    })
    expect(
      (
        await ctx.service
          .completeFetch({ id: src.id, owner: 'owner-a' })
          .then((result) => result.entry)
      ).state,
    ).toBe('local')
  })

  test('whole-blob mismatch publishes nothing and resets the transfer', async () => {
    const src = await sourceBlob(bytesOf(2500, 6))
    const tampered = src.bytes.slice()
    tampered[1500] = (tampered[1500] as number) ^ 0xff
    const tamperedChunks = split(tampered, CHUNK)
    await ctx.service.beginFetch({
      id: src.id,
      owner: 'owner-a',
      manifest: { ...src.manifest, chunks: tamperedChunks.map(digestOf) },
    })
    for (const [index, chunk] of tamperedChunks.entries()) {
      await ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index, bytes: chunk })
    }
    await expect(
      ctx.service.completeFetch({ id: src.id, owner: 'owner-a' }).then((result) => result.entry),
    ).rejects.toThrow(BlobIDMismatchError)
    expect(await backend.has(src.id)).toBe(false)
    expect((await ctx.service.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
    expect(await ctx.store.getChunkDigests(src.id)).toEqual([])
    expect(await listStaging(backend)).toEqual([])
  })

  test('resume across service instances, and a vanished staging area resets', async () => {
    const src = await sourceBlob(bytesOf(2500, 7))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 0,
      bytes: src.chunks[0] as Uint8Array,
    })
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 1,
      bytes: src.chunks[1] as Uint8Array,
    })

    const resumed = createBlobService({ db: ctx.db, backend, chunkSize: CHUNK })
    expect(await resumed.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([0, 1])

    const transfer = await ctx.store.getSession(src.id, 'owner-a')
    await backend.abortStaging(transfer?.stagingID as string)
    expect(await resumed.getPresentChunks({ id: src.id, owner: 'owner-a' })).toEqual([])
    expect((await resumed.get(src.id))?.state).toBe('remote-only')
    expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()

    // The caller begins again and completes.
    await resumed.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    for (const [index, chunk] of src.chunks.entries())
      await resumed.stageChunk({ owner: 'owner-a', id: src.id, index, bytes: chunk })
    expect(
      (await resumed.completeFetch({ id: src.id, owner: 'owner-a' }).then((result) => result.entry))
        .state,
    ).toBe('local')
  })

  test('identical beginFetch after the staging area vanished starts a fresh session', async () => {
    const src = await sourceBlob(bytesOf(2500, 8))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    await ctx.service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 0,
      bytes: src.chunks[0] as Uint8Array,
    })
    const first = await ctx.store.getSession(src.id, 'owner-a')
    await backend.abortStaging(first?.stagingID as string)
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    const second = await ctx.store.getSession(src.id, 'owner-a')
    expect(second?.stagingID).not.toBe(first?.stagingID)
    expect(second?.presentChunks).toEqual([])
  })

  test('stageChunk queued behind completeFetch is rejected', async () => {
    const src = await sourceBlob(bytesOf(2500, 10))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    for (const [index, chunk] of src.chunks.entries())
      await ctx.service.stageChunk({ owner: 'owner-a', id: src.id, index, bytes: chunk })
    const gate = gatedBackend(backend)
    const service = createBlobService({ db: ctx.db, backend: gate.backend, chunkSize: CHUNK })
    const parked = gate.park('commit')
    const done = service
      .completeFetch({ id: src.id, owner: 'owner-a' })
      .then((result) => result.entry)
    await parked.entered
    const late = service.stageChunk({
      owner: 'owner-a',
      id: src.id,
      index: 0,
      bytes: src.chunks[0] as Uint8Array,
    })
    const rejected = expect(late).rejects.toThrow(BlobNotFoundError)
    parked.release()
    await rejected
    expect((await done).state).toBe('local')
    expect(await listStaging(backend)).toEqual([])
  })
})

describe('transfer owners', () => {
  test('owners have independent progress and only one publishes', async () => {
    const ctx = await createTestService({ chunkSize: CHUNK })
    try {
      const src = await sourceBlob(bytesOf(2048, 19))
      const a = { id: src.id, owner: 'owner-a' }
      const b = { id: src.id, owner: 'owner-b' }
      expect(await ctx.service.beginFetch({ ...a, manifest: src.manifest })).toEqual({
        status: 'started',
        presentChunks: [],
      })
      await ctx.service.stageChunk({ ...a, index: 0, bytes: src.chunks[0] as Uint8Array })
      expect(await ctx.service.beginFetch({ ...a, manifest: src.manifest })).toEqual({
        status: 'resumed',
        presentChunks: [0],
      })
      expect(await ctx.service.beginFetch({ ...b, manifest: src.manifest })).toEqual({
        status: 'started',
        presentChunks: [],
      })
      expect(await ctx.service.getPresentChunks(b)).toEqual([])
      expect((await ctx.store.getSession(src.id, a.owner))?.stagingID).not.toBe(
        (await ctx.store.getSession(src.id, b.owner))?.stagingID,
      )
      await expect(ctx.service.completeFetch(b)).rejects.toThrow(TransferIncompleteError)
      for (const key of [a, b])
        for (const [index, bytes] of src.chunks.entries())
          await ctx.service.stageChunk({ ...key, index, bytes })
      const results = await Promise.all([
        ctx.service.completeFetch(a),
        ctx.service.completeFetch(b),
      ])
      expect(results.map((r) => r.fetched).sort()).toEqual([false, true])
      await expect(
        ctx.service.stageChunk({ ...b, index: 0, bytes: src.chunks[0] as Uint8Array }),
      ).rejects.toMatchObject({ name: 'TransferNotFoundError', owner: b.owner, blobState: 'local' })
      expect(await listStaging(ctx.backend)).toEqual([])
    } finally {
      await ctx.db.close()
    }
  })

  test('owner selectors, pagination and abort preserve other owners', async () => {
    const ctx = await createTestService({ chunkSize: CHUNK })
    try {
      const src = await sourceBlob(bytesOf(2048))
      for (const owner of ['owner-a/1', 'owner-a/2', 'owner-ab/1', 'owner-b'])
        await ctx.service.beginFetch({ id: src.id, owner, manifest: src.manifest })
      const page = await ctx.service.listTransfers({ ownerPrefix: 'owner-a/', limit: 1 })
      expect(page.transfers.map((t) => t.owner)).toEqual(['owner-a/1'])
      expect(page.transfers[0]).toMatchObject({ chunkCount: 2, presentCount: 0 })
      expect(
        (
          await ctx.service.listTransfers({
            ownerPrefix: 'owner-a/',
            limit: 1,
            cursor: page.nextCursor as string,
          })
        ).transfers.map((t) => t.owner),
      ).toEqual(['owner-a/2'])
      expect(await ctx.service.abortFetches({ ownerPrefix: 'owner-a/' })).toBe(2)
      expect(await ctx.service.abortFetches({ owner: 'owner-b' })).toBe(1)
      expect(
        (await ctx.service.listTransfers({ blobID: src.id, limit: 10 })).transfers.map(
          (t) => t.owner,
        ),
      ).toEqual(['owner-ab/1'])
      expect(await ctx.service.abortFetch({ id: src.id, owner: 'owner-b' })).toBe(false)
      for (const owner of ['', 'x'.repeat(256), 'é', '\n'])
        await expect(
          ctx.service.beginFetch({ id: src.id, owner, manifest: src.manifest }),
        ).rejects.toThrow()
    } finally {
      await ctx.db.close()
    }
  })

  test('staging limits count sessions and never refuse resumes', async () => {
    const ctx = await createTestService({ chunkSize: CHUNK, limits: { maxStagingBytes: 2048 } })
    try {
      const src = await sourceBlob(bytesOf(2048))
      const key = { id: src.id, owner: 'owner-a' }
      await ctx.service.beginFetch({ ...key, manifest: src.manifest })
      expect((await ctx.service.beginFetch({ ...key, manifest: src.manifest })).status).toBe(
        'resumed',
      )
      await expect(
        ctx.service.beginFetch({ id: src.id, owner: 'owner-b', manifest: src.manifest }),
      ).rejects.toMatchObject({ name: 'StagingLimitError' })
      expect((await ctx.service.listTransfers({ limit: 10 })).transfers).toHaveLength(1)
      await expect(
        ctx.service.write({ expectedID: src.id, stream: sourceOf(src.bytes, 100).stream }),
      ).rejects.toMatchObject({ name: 'StagingLimitError' })
    } finally {
      await ctx.db.close()
    }
  })
})

describe('transfer session isolation', () => {
  test('aborting during a stage removes a recreated area and reports the owner', async () => {
    const gate = gatedBackend()
    const ctx = await createTestService({ backend: gate.backend, chunkSize: CHUNK })
    try {
      const src = await sourceBlob(bytesOf(CHUNK, 22))
      const key = { id: src.id, owner: 'owner-a' }
      await ctx.service.beginFetch({ ...key, manifest: src.manifest })
      const parked = gate.park('writeChunk')
      const staging = ctx.service.stageChunk({ ...key, index: 0, bytes: src.bytes })
      const rejected = expect(staging).rejects.toMatchObject({
        name: 'TransferNotFoundError',
        owner: 'owner-a',
        blobState: 'remote-only',
      })
      await parked.entered
      expect(await ctx.service.abortFetch(key)).toBe(true)
      parked.release()
      await rejected
      expect(await listStaging(ctx.backend)).toEqual([])
    } finally {
      await ctx.db.close()
    }
  })

  test('mismatch ends one owner and a local write ends all remaining sessions', async () => {
    const ctx = await createTestService({ chunkSize: CHUNK })
    try {
      const src = await sourceBlob(bytesOf(CHUNK, 23))
      const wrong = bytesOf(CHUNK, 24)
      const a = { id: src.id, owner: 'owner-a' }
      const b = { id: src.id, owner: 'owner-b' }
      await ctx.service.beginFetch({
        ...a,
        manifest: { ...src.manifest, chunks: [digestOf(wrong)] },
      })
      await ctx.service.beginFetch({ ...b, manifest: src.manifest })
      await ctx.service.stageChunk({ ...a, index: 0, bytes: wrong })
      await ctx.service.stageChunk({ ...b, index: 0, bytes: src.bytes })
      await expect(ctx.service.completeFetch(a)).rejects.toThrow(BlobIDMismatchError)
      expect(await ctx.service.getPresentChunks(b)).toEqual([0])
      expect(
        (await ctx.service.listTransfers({ owner: b.owner, limit: 10 })).transfers,
      ).toHaveLength(1)
      await ctx.service.write({ stream: sourceOf(src.bytes).stream })
      expect((await ctx.service.listTransfers({ blobID: src.id, limit: 10 })).transfers).toEqual([])
      expect((await ctx.service.completeFetch(b)).fetched).toBe(false)
      expect(await listStaging(ctx.backend)).toEqual([])
    } finally {
      await ctx.db.close()
    }
  })

  test('replacing a session leaves crash orphans for pruning and metadata changes restart', async () => {
    const ctx = await createTestService({ chunkSize: CHUNK, logger: { error() {} } })
    try {
      const src = await sourceBlob(bytesOf(CHUNK, 25))
      const key = { id: src.id, owner: 'owner-a' }
      await ctx.service.beginFetch({ ...key, manifest: src.manifest })
      await ctx.service.stageChunk({ ...key, index: 0, bytes: src.bytes })
      const originalAbort = ctx.backend.abortStaging.bind(ctx.backend)
      ctx.backend.abortStaging = async () => {
        throw new Error('crash before cleanup')
      }
      expect(
        (
          await ctx.service.beginFetch({
            ...key,
            manifest: { ...src.manifest, contentType: 'text/plain' },
          })
        ).status,
      ).toBe('restarted')
      ctx.backend.abortStaging = originalAbort
      const current = await ctx.store.getSession(src.id, key.owner)
      if (current === null) throw new Error('Missing replacement session')
      await ctx.store.putSession({ ...current, updatedAt: Date.now() + 2000 })
      expect(await listStaging(ctx.backend)).toHaveLength(1)
      expect(await ctx.service.pruneStaging(new Date(Date.now() + 1000))).toEqual({
        removed: 1,
        failed: 0,
      })
      expect((await ctx.service.listTransfers({ limit: 10 })).transfers).toHaveLength(1)
      const fresh = createBlobService({
        db: ctx.db,
        backend: gatedBackend().backend,
        chunkSize: CHUNK,
      })
      await ctx.service.stageChunk({ ...key, index: 0, bytes: src.bytes })
      expect(
        await fresh.beginFetch({
          ...key,
          manifest: { ...src.manifest, contentType: 'text/plain' },
        }),
      ).toEqual({ status: 'restarted', presentChunks: [] })
    } finally {
      await ctx.db.close()
    }
  })
})

test('pruning ends only stale sessions, including sessions with no staging area', async () => {
  const ctx = await createTestService({ chunkSize: CHUNK })
  try {
    const src = await sourceBlob(bytesOf(CHUNK, 26))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-b', manifest: src.manifest })
    const old = await ctx.store.getSession(src.id, 'owner-a')
    if (old === null) throw new Error('Missing session')
    await ctx.store.putSession({ ...old, updatedAt: 1 })
    expect(await ctx.service.pruneStaging(new Date(2))).toEqual({ removed: 1, failed: 0 })
    expect((await ctx.service.listTransfers({ limit: 10 })).transfers.map((t) => t.owner)).toEqual([
      'owner-b',
    ])
  } finally {
    await ctx.db.close()
  }
})

test('begin on a local blob ends its owner session before returning local', async () => {
  const ctx = await createTestService({ chunkSize: CHUNK })
  try {
    const src = await sourceBlob(bytesOf(CHUNK, 27))
    await ctx.service.write({ stream: sourceOf(src.bytes).stream })
    await ctx.store.putSession({
      blobID: src.id,
      owner: 'owner-a',
      stagingID: 't-local-owner',
      contentLength: CHUNK,
      chunkSize: CHUNK,
      contentType: null,
      encrypted: false,
      keyID: null,
      createdAt: 1,
      updatedAt: 1,
      chunks: src.manifest.chunks.map((digest, index) => ({ index, digest })),
    })
    await ctx.backend.writeChunk('t-local-owner', 0, src.bytes)
    expect(
      await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest }),
    ).toEqual({ status: 'local' })
    expect(await ctx.store.getSession(src.id, 'owner-a')).toBeNull()
    expect(await listStaging(ctx.backend)).toEqual([])
  } finally {
    await ctx.db.close()
  }
})

test('a streamed write counts fetch sessions created after streaming starts', async () => {
  const ctx = await createTestService({
    chunkSize: CHUNK,
    limits: { maxStagingBytes: CHUNK + 128 },
  })
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()
  void writer.closed.catch(() => {})
  try {
    const src = await sourceBlob(bytesOf(CHUNK, 28))
    const writing = ctx.service.write({ stream: stream.readable })
    const rejected = expect(writing).rejects.toMatchObject({ name: 'StagingLimitError' })
    await writer.write(bytesOf(100))
    await vi.waitFor(
      async () => {
        const areas = await listStaging(ctx.backend)
        expect(areas).toHaveLength(1)
        expect(
          (await readAll(await ctx.backend.createStagingReadStream(areas[0] as string))).length,
        ).toBe(100)
      },
      { timeout: 60000 },
    )
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    await writer.write(bytesOf(100)).catch(() => {})
    await writer.close().catch(() => {})
    await rejected
    expect(await listStaging(ctx.backend)).toEqual([])
  } finally {
    await ctx.db.close()
  }
})

test('session pruning works without backend staging enumeration', async () => {
  const memory = gatedBackend().backend
  const backend = { ...memory, listStaging: undefined }
  const ctx = await createTestService({ backend, chunkSize: CHUNK })
  try {
    const src = await sourceBlob(bytesOf(CHUNK, 29))
    await ctx.service.beginFetch({ id: src.id, owner: 'owner-a', manifest: src.manifest })
    expect(await ctx.service.pruneStaging(new Date(Date.now() + 1000))).toEqual({
      removed: 1,
      failed: 0,
    })
    expect((await ctx.service.listTransfers({ limit: 10 })).transfers).toEqual([])
  } finally {
    await ctx.db.close()
  }
})
