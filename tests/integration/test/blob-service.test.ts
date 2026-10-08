import type { BlobService } from '@hozon/blob'
import { createBlobService } from '@hozon/blob'
import { MemoryBlobBackend } from '@hozon/blob-backend'
import { blake3Codec } from '@hozon/blob-id'
import { HozonDB } from '@hozon/db'
import type { BlobStoreAPI } from '@hozon/store-blob'
import { blobStoreDefinition, getBlobStore } from '@hozon/store-blob'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

const CHUNK = 1024

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
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

function bytesOf(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 13 + seed) % 256)
}

describe.each(backends())('blob service ($name)', (backend) => {
  const databases: Array<HozonDB> = []

  // Each call opens a fresh database and a fresh in-memory byte backend.
  async function openService(): Promise<{ service: BlobService; store: BlobStoreAPI }> {
    const db = new HozonDB({ adapter: await backend.createAdapter() })
    databases.push(db)
    db.register(blobStoreDefinition)
    const service = createBlobService({
      db,
      backend: new MemoryBlobBackend(),
      codec: blake3Codec,
      chunkSize: CHUNK,
    })
    return { service, store: await getBlobStore(db) }
  }

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()))
    await backend.cleanup()
  })

  test('write and read a range', async () => {
    const { service } = await openService()
    const bytes = bytesOf(2500, 3)
    const { entry, created } = await service.write(streamOf(bytes), { contentType: 'text/plain' })
    expect(created).toBe(true)
    expect(entry).toMatchObject({ state: 'local', contentLength: 2500, chunkSize: CHUNK })
    expect(await readAll(await service.createReadStream(entry.blobID))).toEqual(bytes)
    expect(
      await readAll(await service.createReadStream(entry.blobID, { start: 1000, end: 1999 })),
    ).toEqual(bytes.slice(1000, 2000))
    expect((await service.write(streamOf(bytes))).created).toBe(false)
  })

  test('transfer between two services sharing nothing but bytes', async () => {
    const source = await openService()
    const dest = await openService()
    const bytes = bytesOf(2500, 9)
    const { entry } = await source.service.write(streamOf(bytes))
    const id = entry.blobID

    await dest.service.beginFetch(id, {
      contentLength: entry.contentLength,
      chunkSize: entry.chunkSize,
      chunks: await source.service.getChunkDigests(id),
    })
    expect((await dest.service.get(id))?.state).toBe('partial')
    for (let index = 2; index >= 0; index--) {
      const range = { start: index * CHUNK, end: Math.min((index + 1) * CHUNK, 2500) - 1 }
      const chunk = await readAll(await source.service.createReadStream(id, range))
      await dest.service.stageChunk(id, index, chunk)
    }
    expect(await dest.service.getPresentChunks(id)).toEqual([0, 1, 2])
    expect((await dest.service.completeFetch(id)).state).toBe('local')
    expect(await readAll(await dest.service.createReadStream(id))).toEqual(bytes)
  })

  test('writeWith rolls back the row when the callback throws', async () => {
    const { service, store } = await openService()
    const bytes = bytesOf(100, 1)
    await expect(
      service.writeWith(streamOf(bytes), {}, async () => {
        throw new Error('callback failed')
      }),
    ).rejects.toThrow('callback failed')
    const id = blake3Codec.encode({
      digest: await digestOf(bytes),
      contentLength: bytes.length,
    })
    expect(await store.getEntry(id)).toBeNull()

    const ok = await service.writeWith(streamOf(bytes), {}, async (_tx, entry) => entry.blobID)
    expect(ok.result).toBe(id)
    expect(ok.entry.state).toBe('local')
  })

  test('delete removes the blob', async () => {
    const { service } = await openService()
    const { entry } = await service.write(streamOf(bytesOf(50)))
    expect(await service.delete(entry.blobID)).toBe(true)
    expect(await service.has(entry.blobID)).toBe(false)
    expect(await service.get(entry.blobID)).toBeNull()
    expect(await service.delete(entry.blobID)).toBe(false)
  })

  test('list paginates', async () => {
    const { service } = await openService()
    const ids = new Set<string>()
    for (let seed = 0; seed < 5; seed++) {
      ids.add((await service.write(streamOf(bytesOf(20 + seed, seed)))).entry.blobID)
    }
    const seen: Array<string> = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await service.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
      seen.push(...page.entries.map((entry) => entry.blobID))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor !== undefined)
    expect(pages).toBe(3)
    expect(new Set(seen)).toEqual(ids)
    expect(seen).toHaveLength(5)
  })
})

async function digestOf(bytes: Uint8Array): Promise<Uint8Array> {
  const hasher = blake3Codec.createHasher()
  hasher.update(bytes)
  return hasher.digest()
}
