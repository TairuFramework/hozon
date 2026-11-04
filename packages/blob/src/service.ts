import type { BlobBackend, BlobRange } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import { blake3Codec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type {
  BlobEntry,
  BlobHolderSelector,
  BlobRef,
  BlobRefInput,
  FindRefsParams,
} from '@hozon/store-blob'
import type { Runtime } from '@sozai/runtime'
import { createRuntime } from '@sozai/runtime'

import { assertChunkSize, type BlobLimits, DEFAULT_CHUNK_SIZE, resolveLimits } from './limits.js'
import { lockBlobs, retryTransaction } from './locking.js'
import {
  type CollectParams,
  type CollectResult,
  collect,
  type MaintenanceParams,
  type MaintenanceResult,
  type ReconcileParams,
  type ReconcileResult,
  reconcileBytes,
  runMaintenance,
} from './maintenance.js'
import { deleteBlob, drainByteDeletions, evictBlob, setBlobPinned } from './manage.js'
import { pruneStaging } from './prune.js'
import { createBlobReadStream, getChunkDigests, getEntry, hasBlob, listEntries } from './read.js'
import { addRefs, findRefs, listRefs, removeHolders, removeRefs } from './refs.js'
import {
  abortFetch,
  abortFetches,
  type BeginFetchParams,
  type BeginFetchResult,
  type BlobTransferInfo,
  beginFetch,
  type CompleteFetchResult,
  completeFetch,
  getPresentChunks,
  type ListTransfersParams,
  listTransfers,
  type StageChunkParams,
  stageChunk,
  type TransferKey,
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
  delete(id: string, options?: { force?: boolean }): Promise<boolean>
  evict(id: string): Promise<boolean>
  addRefs(refs: Array<BlobRefInput>): Promise<Map<string, BlobEntry | null>>
  removeRefs(refs: Array<BlobRefInput>): Promise<number>
  removeHolders(selector: BlobHolderSelector): Promise<number>
  listRefs(id: string): Promise<Array<BlobRef>>
  findRefs(params: FindRefsParams): Promise<{ refs: Array<BlobRef>; nextCursor: string | null }>
  beginFetch(params: BeginFetchParams): Promise<BeginFetchResult>
  getPresentChunks(params: TransferKey): Promise<Array<number>>
  stageChunk(params: StageChunkParams): Promise<void>
  completeFetch(params: TransferKey): Promise<CompleteFetchResult>
  abortFetch(params: TransferKey): Promise<boolean>
  abortFetches(params: { owner: string } | { ownerPrefix: string }): Promise<number>
  listTransfers(
    params: ListTransfersParams,
  ): Promise<{ transfers: Array<BlobTransferInfo>; nextCursor: string | null }>
  withLocks<R>(
    ids: Array<string>,
    fn: (ops: BlobOperations, tx: StoreProvider) => Promise<R>,
  ): Promise<R>
}

export type BlobService = BlobOperations & {
  collect(params: CollectParams): Promise<CollectResult>
  reconcileBytes(params: ReconcileParams): Promise<ReconcileResult>
  runMaintenance(params: MaintenanceParams): Promise<MaintenanceResult>
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
      delete: (id, options) => deleteBlob(view, id, options),
      evict: (id) => evictBlob(view, id),
      addRefs: (refs) => addRefs(view, refs),
      removeRefs: (refs) => removeRefs(view, refs),
      removeHolders: (selector) => removeHolders(view, selector),
      listRefs: (id) => listRefs(view, id),
      findRefs: (params) => findRefs(view, params),
      beginFetch: (params) => beginFetch(view, params),
      getPresentChunks: (id) => getPresentChunks(view, id),
      stageChunk: (params) => stageChunk(view, params),
      completeFetch: (id) => completeFetch(view, id),
      abortFetch: (params) => abortFetch(view, params),
      abortFetches: (params) => abortFetches(view, params),
      listTransfers: (params) => listTransfers(view, params),
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
    collect: (params) => collect(ctx, params),
    reconcileBytes: (params) => reconcileBytes(ctx, params),
    runMaintenance: (params) => runMaintenance(ctx, params),
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
