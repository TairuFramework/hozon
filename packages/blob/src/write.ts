import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import type { BlobIDCodec, HashResult } from '@hozon/blob-id'
import { hashStream } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobChunkInput, BlobEntry, BlobEntryInput, BlobStoreAPI } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'

import {
  BlobIDMismatchError,
  BlobTooLargeError,
  BlobWriteAbortedError,
  ContentTypeMismatchError,
} from './errors.js'
import type { BlobLimits } from './limits.js'

export type WriteOptions = {
  contentType?: string
  encrypted?: boolean
  keyID?: string
  expectedID?: string
  maxSize?: number
  signal?: AbortSignal
}

export type WriteResult = { entry: BlobEntry; created: boolean }

export type WriteContext = {
  db: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
  chunkSize: number
  lock: BlobLock
  limits: BlobLimits
  // Staging IDs of writes in progress, which staging pruning must skip.
  activeWrites: Set<string>
}

export type RecordFn<T> = (tx: StoreProvider, entry: BlobEntry) => Promise<T>

function createWriteStagingID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `w-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
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

type Recorded<T> = { entry: BlobEntry; result: T | undefined }

// Records the blob under the lock, inside a transaction when `fn` is given.
async function record<T>(
  ctx: WriteContext,
  fn: RecordFn<T> | undefined,
  step: (store: BlobStoreAPI) => Promise<BlobEntry>,
): Promise<Recorded<T>> {
  if (fn === undefined) {
    return { entry: await step(await getBlobStore(ctx.db)), result: undefined }
  }
  return await ctx.db.withTransaction(async (tx) => {
    const store = await getBlobStore(tx)
    const entry = await step(store)
    return { entry, result: await fn(tx, entry) }
  })
}

export async function writeBlob<T>(
  ctx: WriteContext,
  stream: ReadableStream<Uint8Array>,
  options: WriteOptions,
  fn?: RecordFn<T>,
): Promise<WriteResult & { result: T | undefined }> {
  const { signal } = options
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

  // Step 1: validate the expected ID before reading the body.
  try {
    throwIfAborted(signal)
    if (options.expectedID !== undefined) {
      expectedID = ctx.codec.canonicalize(options.expectedID)
      const expected = ctx.codec.decode(expectedID)
      if (expected.contentType !== undefined) {
        if (contentType === undefined) {
          contentType = expected.contentType
        } else if (contentType !== expected.contentType) {
          throw new ContentTypeMismatchError(expected.contentType, contentType)
        }
      }
      if (expected.contentLength > limit) throw new BlobTooLargeError(limit)
    }
  } catch (error) {
    await cancelQuietly(stream, error)
    throw error
  }

  // Step 2: stream into a fresh staging area while hashing.
  const stagingID = createWriteStagingID()
  ctx.activeWrites.add(stagingID)
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
      const sink = await ctx.backend.createStaging(stagingID)
      const hasher = hashStream(ctx.codec, ctx.chunkSize)
      await stream
        .pipeThrough(sizeLimiter(limit))
        .pipeThrough(hasher.transform)
        .pipeTo(sink, signal === undefined ? {} : { signal })
      hashed = await hasher.result
    } catch (error) {
      // Releases the source when staging failed before the pipe started.
      if (!stream.locked) await cancelQuietly(stream, error)
      if (signal?.aborted) throw new BlobWriteAbortedError(undefined, { cause: error })
      throw error
    }

    // Step 3: derive the ID and check it against the expected one.
    const blobID = ctx.codec.encode({
      digest: hashed.digest,
      contentLength: hashed.contentLength,
      ...(contentType === undefined ? {} : { contentType }),
    })
    if (expectedID !== undefined && blobID !== expectedID) {
      throw new BlobIDMismatchError(expectedID, blobID)
    }

    // Step 4: commit bytes, then record the entry, under the blob lock.
    return await ctx.lock.withLock(blobID, async () => {
      throwIfAborted(signal)
      const store = await getBlobStore(ctx.db)
      const existing = await store.getEntry(blobID)

      if (existing?.state === 'local') {
        await discardStaging()
        // Existing metadata wins; only a null content type is filled in.
        const fill = async (target: BlobStoreAPI): Promise<BlobEntry> => {
          if (existing.contentType !== null || contentType === undefined) return existing
          await target.fillContentType(blobID, contentType)
          return (await target.getEntry(blobID)) ?? existing
        }
        const { entry, result } = await record(ctx, fn, fill)
        return { entry, created: false, result }
      }

      const transfer = existing === null ? null : await store.getTransfer(blobID)
      // Step 5: bytes are committed before the row. Re-check: the awaits above may outlast an abort.
      throwIfAborted(signal)
      await ctx.backend.commit(stagingID, blobID)
      staged = false

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
      const promote = async (target: BlobStoreAPI): Promise<BlobEntry> => {
        await target.promoteEntry(input, chunks)
        const entry = await target.getEntry(blobID)
        if (entry === null) throw new Error(`Blob entry ${blobID} missing after promotion`)
        return entry
      }
      const { entry, result } = await record(ctx, fn, promote)

      // The promoted entry no longer references the transfer's staging area.
      if (transfer !== null) {
        try {
          await ctx.backend.abortStaging(transfer.stagingID)
        } catch {
          // Reclaimed by staging pruning.
        }
      }
      return { entry, created: true, result }
    })
  } finally {
    await discardStaging()
    ctx.activeWrites.delete(stagingID)
  }
}
