import type { BlobBackend, BlobLock, BlobRange } from '@hozon/blob-backend'
import { createMemoryBlobLock } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { blake3Codec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry } from '@hozon/store-blob'

import { assertChunkSize, type BlobLimits, DEFAULT_CHUNK_SIZE, resolveLimits } from './limits.js'
import { deleteBlob, setBlobPinned } from './manage.js'
import { createBlobReadStream, getChunkDigests, getEntry, hasBlob, listEntries } from './read.js'
import { type WriteContext, type WriteOptions, type WriteResult, writeBlob } from './write.js'

export type BlobServiceParams = {
  // Must have `blobStoreDefinition` registered.
  db: StoreProvider
  backend: BlobBackend
  codec?: BlobIDCodec
  chunkSize?: number
  lock?: BlobLock
  limits?: Partial<BlobLimits>
}

export type BlobService = {
  write(stream: ReadableStream<Uint8Array>, options?: WriteOptions): Promise<WriteResult>
  writeWith<T>(
    stream: ReadableStream<Uint8Array>,
    options: WriteOptions,
    fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T>,
  ): Promise<WriteResult & { result: T }>
  get(id: string): Promise<BlobEntry | null>
  list(params: {
    limit: number
    cursor?: string
  }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>
  has(id: string): Promise<boolean>
  getChunkDigests(id: string): Promise<Array<Uint8Array>>
  createReadStream(id: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>>
  setPinned(id: string, pinned: boolean): Promise<void>
  delete(id: string): Promise<boolean>
  readonly codec: BlobIDCodec
  readonly limits: BlobLimits
}

export function createBlobService(params: BlobServiceParams): BlobService {
  const limits = resolveLimits(params.limits)
  const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE
  assertChunkSize(chunkSize, limits)
  const ctx: WriteContext = {
    db: params.db,
    backend: params.backend,
    codec: params.codec ?? blake3Codec,
    chunkSize,
    lock: params.lock ?? createMemoryBlobLock(),
    limits,
    activeWrites: new Set(),
  }

  return {
    codec: ctx.codec,
    limits: ctx.limits,
    get: (id) => getEntry(ctx, id),
    list: (listParams) => listEntries(ctx, listParams),
    has: (id) => hasBlob(ctx, id),
    getChunkDigests: (id) => getChunkDigests(ctx, id),
    createReadStream: (id, range) => createBlobReadStream(ctx, id, range),
    setPinned: (id, pinned) => setBlobPinned(ctx, id, pinned),
    delete: (id) => deleteBlob(ctx, id),
    async write(stream, options = {}) {
      const { entry, created } = await writeBlob(ctx, stream, options)
      return { entry, created }
    },
    async writeWith<T>(
      stream: ReadableStream<Uint8Array>,
      options: WriteOptions,
      fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T>,
    ) {
      const { entry, created, result } = await writeBlob(ctx, stream, options, fn)
      return { entry, created, result: result as T }
    },
  }
}
