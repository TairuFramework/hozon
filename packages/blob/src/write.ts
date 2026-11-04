import type { BlobBackend } from '@hozon/blob-backend'
import type { BlobIDCodec, HashResult } from '@hozon/blob-id'
import { hashStream } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobChunkInput, BlobEntry, BlobEntryInput, BlobStoreAPI } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'
import type { Runtime } from '@sozai/runtime'

import {
  BlobIDMismatchError,
  BlobTooLargeError,
  BlobWriteAbortedError,
  ContentTypeMismatchError,
  StagingLimitError,
} from './errors.js'
import { getFreshEntry } from './fresh.js'
import type { BlobLimits } from './limits.js'
import { lockBlobs } from './locking.js'
import { afterCommit, reclaimOnRollback } from './manage.js'
import { commitStaging } from './publish.js'
import { allSessions } from './transfer.js'

export type WriteOptions = {
  contentType?: string
  encrypted?: boolean
  keyID?: string
  expectedID?: string
  maxSize?: number
  signal?: AbortSignal
}

export type WriteParams = WriteOptions & { stream: ReadableStream<Uint8Array> }

export type WriteResult = { entry: BlobEntry; created: boolean }

export type WriteContext = {
  db: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
  chunkSize: number
  root: StoreProvider
  logError(error: unknown): void
  limits: BlobLimits
  runtime: Runtime
  // Staging IDs of writes in progress, which staging pruning must skip.
  activeWrites: Map<string, number>
}

export type WriteReplay = {
  prepared?: {
    stagingID: string
    hashed: HashResult
    blobID: string
    contentType: string | undefined
  }
  originalError?: unknown
  cleanup?: () => Promise<void>
}

// Random staging ID: `prefix` (`w` for writes, `t` for transfers), a dash, 32 hex chars.
export function createStagingID(runtime: Runtime, prefix: 'w' | 't'): string {
  const bytes = runtime.getRandomValues(new Uint8Array(16))
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function sizeLimiter(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0
  return new TransformStream({
    transform(piece, controller) {
      total += piece.length
      if (total > limit) throw new BlobTooLargeError(limit)
      controller.enqueue(piece)
    },
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BlobWriteAbortedError(undefined, { cause: signal.reason })
}

async function cancelQuietly(stream: ReadableStream<Uint8Array>, reason: unknown): Promise<void> {
  try {
    await stream.cancel(reason)
  } catch {
    // The caller's error matters more than a failed cancel.
  }
}

async function sessionContentLength(ctx: WriteContext): Promise<number> {
  // Enter through the provider so root calls retain caller-transaction scope detection.
  return await ctx.db.withTransaction(async (tx) => {
    return await (await getBlobStore(tx)).sumSessionContentLength()
  })
}

export async function writeBlob(
  ctx: WriteContext,
  params: WriteParams,
  replay?: WriteReplay,
): Promise<WriteResult> {
  const { stream, ...options } = params
  const { signal } = options
  if (
    options.contentType !== undefined &&
    (typeof options.contentType !== 'string' || options.contentType.length > 255)
  ) {
    await cancelQuietly(stream, new Error('Invalid contentType'))
    throw new Error('Invalid contentType')
  }
  if (
    options.maxSize !== undefined &&
    (!Number.isSafeInteger(options.maxSize) || options.maxSize < 0)
  ) {
    await cancelQuietly(stream, new Error('Invalid maxSize'))
    throw new Error('Invalid maxSize')
  }
  const limit = Math.min(options.maxSize ?? Number.POSITIVE_INFINITY, ctx.limits.maxBlobSize)
  let contentType = options.contentType
  let expectedID: string | undefined

  const sessionBytes =
    ctx.limits.maxStagingBytes === undefined ? 0 : await sessionContentLength(ctx)
  try {
    throwIfAborted(signal)
    if (options.expectedID !== undefined) {
      expectedID = ctx.codec.canonicalize(options.expectedID)
      const expected = ctx.codec.decode(expectedID)
      if (expected.contentType !== undefined) {
        if (contentType === undefined) {
          contentType = expected.contentType
        } else if (contentType !== expected.contentType) {
          throw new ContentTypeMismatchError({
            expected: expected.contentType,
            actual: contentType,
          })
        }
      }
      if (
        replay?.prepared === undefined &&
        ctx.limits.maxStagingBytes !== undefined &&
        sessionBytes +
          [...ctx.activeWrites.values()].reduce((sum, size) => sum + size, 0) +
          expected.contentLength >
          ctx.limits.maxStagingBytes
      ) {
        throw new StagingLimitError()
      }
      if (expected.contentLength > limit) throw new BlobTooLargeError(limit)
    }
  } catch (error) {
    await cancelQuietly(stream, error)
    throw error
  }

  const stagingID = replay?.prepared?.stagingID ?? createStagingID(ctx.runtime, 'w')
  if (replay?.prepared === undefined) ctx.activeWrites.set(stagingID, 0)
  let staged = true
  const discardStaging = async (): Promise<void> => {
    if (!staged) return
    staged = false
    try {
      await ctx.backend.abortStaging(stagingID)
    } catch {
      // An orphaned staging area is reclaimed by staging pruning.
    }
  }

  try {
    let hashed: HashResult
    try {
      if (replay?.prepared !== undefined) {
        hashed = replay.prepared.hashed
        contentType = replay.prepared.contentType
      } else {
        const sink = await ctx.backend.createStaging(stagingID)
        const hasher = hashStream({ codec: ctx.codec, chunkSize: ctx.chunkSize })
        await stream
          .pipeThrough(sizeLimiter(limit))
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              async transform(piece, controller) {
                const size = (ctx.activeWrites.get(stagingID) ?? 0) + piece.length
                ctx.activeWrites.set(stagingID, size)
                if (
                  ctx.limits.maxStagingBytes !== undefined &&
                  (await sessionContentLength(ctx)) +
                    [...ctx.activeWrites.values()].reduce((sum, bytes) => sum + bytes, 0) >
                    ctx.limits.maxStagingBytes
                ) {
                  throw new StagingLimitError()
                }
                controller.enqueue(piece)
              },
            }),
          )
          .pipeThrough(hasher.transform)
          .pipeTo(sink, signal === undefined ? {} : { signal })
        hashed = await hasher.result
      }
    } catch (error) {
      // Releases the source when staging failed before the pipe started.
      if (!stream.locked) await cancelQuietly(stream, error)
      if (signal?.aborted) throw new BlobWriteAbortedError(undefined, { cause: error })
      throw error
    }

    const blobID = ctx.codec.encode({
      digest: hashed.digest,
      contentLength: hashed.contentLength,
      ...(contentType === undefined ? {} : { contentType }),
    })
    if (expectedID !== undefined && blobID !== expectedID) {
      throw new BlobIDMismatchError({ expected: expectedID, actual: blobID })
    }

    if (replay !== undefined) replay.prepared = { stagingID, hashed, blobID, contentType }
    let cleanup: Promise<boolean> | undefined
    const result = await lockBlobs(ctx.db, [blobID], async (tx, originalError) => {
      throwIfAborted(signal)
      const store = await getBlobStore(tx)
      const existing = await getFreshEntry(store, blobID)

      if (existing?.state === 'local') {
        await discardStaging()
        // Existing metadata wins; only a null content type is filled in.
        const fill = async (target: BlobStoreAPI): Promise<BlobEntry> => {
          if (existing.contentType !== null || contentType === undefined) return existing
          await target.fillContentType(blobID, contentType)
          return (await getFreshEntry(target, blobID)) ?? existing
        }
        return { entry: await fill(store), created: false }
      }

      const sessions = existing === null ? [] : await allSessions(store, blobID)
      throwIfAborted(signal)

      const input: Omit<BlobEntryInput, 'state'> = {
        blobID,
        contentLength: hashed.contentLength,
        encrypted: options.encrypted ?? false,
        keyID: options.keyID ?? null,
        chunkSize: ctx.chunkSize,
        createdAt: Date.now(),
        contentType: contentType ?? null,
      }
      const chunks: Array<BlobChunkInput> = hashed.chunks.map((digest, index) => ({
        index,
        digest,
      }))
      const publish = async (provider: StoreProvider) => {
        const target = await getBlobStore(provider)
        await target.promoteEntry(input, chunks)
        const entry = await getFreshEntry(target, blobID)
        if (entry === null) throw new Error(`Blob entry ${blobID} missing after promotion`)
        cleanup = afterCommit(ctx, provider, async () => {
          await Promise.all(sessions.map((session) => ctx.backend.abortStaging(session.stagingID)))
        })
        if (ctx.db.isTransactionBound) reclaimOnRollback(ctx, provider, blobID)
        await commitStaging(ctx.backend, stagingID, blobID, originalError ?? replay?.originalError)
        staged = false
        return { entry, created: true }
      }
      // A caller can catch publication failure and still commit its transaction.
      if (ctx.db.isTransactionBound) {
        if (tx.withSavepoint === undefined)
          throw new Error('Blob publication requires savepoint support')
        return await tx.withSavepoint(publish)
      }
      return await publish(tx)
    })
    if (!ctx.db.isTransactionBound) await cleanup
    return result
  } finally {
    const cleanup = async () => {
      await discardStaging()
      ctx.activeWrites.delete(stagingID)
    }
    if (replay === undefined) await cleanup()
    else replay.cleanup = cleanup
  }
}
