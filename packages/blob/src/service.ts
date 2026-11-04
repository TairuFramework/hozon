import type { BlobBackend, BlobRange } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { blake3Codec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry } from '@hozon/store-blob'
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

import { assertChunkSize, type BlobLimits, DEFAULT_CHUNK_SIZE, resolveLimits } from './limits.js'
import { lockBlobs, retryTransaction } from './locking.js'
import { deleteBlob, drainByteDeletions, setBlobPinned } from './manage.js'
import { pruneStaging } from './prune.js'
import { createBlobReadStream, getChunkDigests, getEntry, hasBlob, listEntries } from './read.js'
import {
  beginFetch,
  completeFetch,
  getPresentChunks,
  type StageChunkParams,
  stageChunk,
  type TransferManifest,
} from './transfer.js'
import {
  type WriteContext,
  type WriteParams,
  type WriteReplay,
  type WriteResult,
  writeBlob,
} from './write.js'

export type BlobServiceParams = {
  // Must have `blobStoreDefinition` registered.
  db: StoreProvider
  backend: BlobBackend
  codec?: BlobIDCodec
  chunkSize?: number
  logger?: { error(message: string, properties: Record<string, unknown>): void }
  limits?: Partial<BlobLimits>
  runtime?: Runtime
}

export type BlobOperations = {
  write(params: WriteParams): Promise<WriteResult>
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
  beginFetch(id: string, manifest: TransferManifest): Promise<void>
  getPresentChunks(id: string): Promise<Array<number>>
  stageChunk(params: StageChunkParams): Promise<void>
  completeFetch(id: string): Promise<BlobEntry>
  withLocks<R>(
    ids: Array<string>,
    fn: (ops: BlobOperations, tx: StoreProvider) => Promise<R>,
  ): Promise<R>
}

export type BlobService = BlobOperations & {
  using(provider: StoreProvider): BlobOperations
  writeWith<T>(
    params: WriteParams & { fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T> },
  ): Promise<WriteResult & { result: T }>
  drainByteDeletions(params?: { limit?: number }): Promise<{ deleted: number; failed: number }>
  // Aborts staging areas not modified since `olderThan`: abandoned writes and stale transfers.
  pruneStaging(olderThan: Date): Promise<{ removed: number; failed: number }>
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
    root: params.db.root ?? params.db,
    logError: (error) => {
      try {
        if (params.logger !== undefined)
          params.logger.error('Blob cleanup failed: {error}', { error })
        else console.error('Blob cleanup failed', error)
      } catch {
        /* Logging must not reject a cleanup hook. */
      }
    },
    limits: Object.freeze(limits),
    runtime: params.runtime ?? createRuntime(),
    activeWrites: new Map(),
  }

  function using(provider: StoreProvider, replay?: WriteReplay): BlobOperations {
    const view = { ...ctx, db: provider }
    return {
      get: (id) => getEntry(view, id),
      list: (params) => listEntries(view, params),
      has: (id) => hasBlob(view, id),
      getChunkDigests: (id) => getChunkDigests(view, id),
      createReadStream: (id, range) => createBlobReadStream(view, id, range),
      setPinned: (id, pinned) => setBlobPinned(view, id, pinned),
      delete: (id) => deleteBlob(view, id),
      beginFetch: (id, manifest) => beginFetch(view, id, manifest),
      getPresentChunks: (id) => getPresentChunks(view, id),
      stageChunk: (params) => stageChunk(view, params),
      completeFetch: (id) => completeFetch(view, id),
      write: (params) => writeBlob(view, params, replay),
      withLocks: (ids, fn) =>
        lockBlobs(
          provider,
          ids.map((id) => ctx.codec.canonicalize(id)),
          (tx) => fn(using(tx), tx),
        ),
    }
  }
  const ops = using(params.db)
  return {
    ...ops,
    using,
    codec: ctx.codec,
    limits: ctx.limits,
    pruneStaging: (olderThan) => pruneStaging(ctx, olderThan),
    drainByteDeletions: (params) => drainByteDeletions(ctx, params),
    writeWith: (params) => paramsDBTransaction(params),
  }

  async function paramsDBTransaction<T>(
    input: WriteParams & { fn: (tx: StoreProvider, entry: BlobEntry) => Promise<T> },
  ): Promise<WriteResult & { result: T }> {
    const replay: WriteReplay = {}
    try {
      return await retryTransaction(params.db, async (originalError) => {
        replay.originalError = originalError
        return await params.db.withTransaction(async (tx) => {
          const written = await using(tx, replay).write(input)
          return { ...written, result: await input.fn(tx, written.entry) }
        })
      })
    } finally {
      await replay.cleanup?.()
    }
  }
}
