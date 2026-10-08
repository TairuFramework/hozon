import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import { createMemoryBlobLock } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { blake3Codec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry } from '@hozon/store-blob'

import { assertChunkSize, type BlobLimits, DEFAULT_CHUNK_SIZE, resolveLimits } from './limits.js'
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
