import type { BlobBackend, BlobLock } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry, BlobStoreAPI, BlobTransfer } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'

import {
  BlobIDMismatchError,
  BlobNotFoundError,
  ChunkDigestMismatchError,
  ChunkLengthError,
  InvalidManifestError,
  TransferIncompleteError,
} from './errors.js'
import type { BlobLimits } from './limits.js'
import { createStagingID } from './write.js'

// Untrusted manifest received from a peer. Every field is validated against
// the ID and the service limits before anything is recorded.
export type TransferManifest = {
  contentLength: number
  chunkSize: number
  chunks: Array<Uint8Array>
  contentType?: string
  encrypted?: boolean
  keyID?: string
}

export type TransferContext = {
  db: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
  // The service's chunk size, recorded for zero-length transfers.
  chunkSize: number
  lock: BlobLock
  limits: BlobLimits
}

type ActiveTransfer = {
  store: BlobStoreAPI
  entry: BlobEntry
  transfer: BlobTransfer
  digests: Array<Uint8Array>
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function digestsEqual(a: Array<Uint8Array>, b: Array<Uint8Array>): boolean {
  return a.length === b.length && a.every((digest, i) => bytesEqual(digest, b[i] as Uint8Array))
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function chunkCount(contentLength: number, chunkSize: number): number {
  return contentLength === 0 ? 0 : Math.ceil(contentLength / chunkSize)
}

// Expected length of chunk `index`: `chunkSize`, or the remainder for the last chunk.
function chunkLength(entry: BlobEntry, count: number, index: number): number {
  return index < count - 1 ? entry.chunkSize : entry.contentLength - (count - 1) * entry.chunkSize
}

// Returns the content type to record: the manifest's, or the one embedded in the ID.
function validateManifest(
  ctx: TransferContext,
  blobID: string,
  manifest: TransferManifest,
): string | undefined {
  const { contentLength, chunkSize, chunks } = manifest
  if (!isSafeNonNegativeInteger(contentLength)) {
    throw new InvalidManifestError(`contentLength ${contentLength} is not a non-negative integer`)
  }
  if (!isSafeNonNegativeInteger(chunkSize)) {
    throw new InvalidManifestError(`chunkSize ${chunkSize} is not a non-negative integer`)
  }
  // A zero-length blob has no chunks, so its chunk size is not constrained.
  if (
    contentLength > 0 &&
    (chunkSize < ctx.limits.minChunkSize || chunkSize > ctx.limits.maxChunkSize)
  ) {
    throw new InvalidManifestError(
      `chunkSize ${chunkSize} is outside [${ctx.limits.minChunkSize}, ${ctx.limits.maxChunkSize}]`,
    )
  }
  if (contentLength > ctx.limits.maxBlobSize) {
    throw new InvalidManifestError(
      `contentLength ${contentLength} exceeds the size limit of ${ctx.limits.maxBlobSize} bytes`,
    )
  }
  const expectedCount = chunkCount(contentLength, chunkSize)
  if (!Array.isArray(chunks) || chunks.length !== expectedCount) {
    throw new InvalidManifestError(`expected ${expectedCount} chunk digest(s)`)
  }
  for (const [index, digest] of chunks.entries()) {
    if (!(digest instanceof Uint8Array) || digest.length !== ctx.codec.digestLength) {
      throw new InvalidManifestError(
        `chunk ${index} digest must be ${ctx.codec.digestLength} bytes`,
      )
    }
  }
  const { contentType, encrypted, keyID } = manifest
  if (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > 255)) {
    throw new InvalidManifestError('contentType must be a string of at most 255 characters')
  }
  if (encrypted !== undefined && typeof encrypted !== 'boolean') {
    throw new InvalidManifestError('encrypted must be a boolean')
  }
  if (keyID !== undefined && (typeof keyID !== 'string' || keyID.length > 255)) {
    throw new InvalidManifestError('keyID must be a string of at most 255 characters')
  }
  const decoded = ctx.codec.decode(blobID)
  if (decoded.contentLength !== contentLength) {
    throw new InvalidManifestError(
      `contentLength ${contentLength} does not match the ID (${decoded.contentLength})`,
    )
  }
  if (decoded.contentType === undefined) return manifest.contentType
  if (manifest.contentType !== undefined && manifest.contentType !== decoded.contentType) {
    throw new InvalidManifestError(
      `contentType ${JSON.stringify(manifest.contentType)} does not match the ID (${JSON.stringify(decoded.contentType)})`,
    )
  }
  return decoded.contentType
}

async function abortQuietly(backend: BlobBackend, stagingID: string): Promise<void> {
  try {
    await backend.abortStaging(stagingID)
  } catch {
    // Reclaimed by staging pruning.
  }
}

// Whether the staging area of a session with staged chunks still exists.
// Backends create staging lazily, so a session without chunks has no area yet.
async function stagingExists(
  backend: BlobBackend,
  transfer: BlobTransfer,
  chunkSize: number,
): Promise<boolean> {
  const first = transfer.presentChunks[0]
  if (first === undefined) return true
  const start = first * chunkSize
  let probe: ReadableStream<Uint8Array>
  try {
    probe = await backend.createStagingReadStream(transfer.stagingID, { start, end: start })
  } catch {
    return false
  }
  try {
    await probe.cancel()
  } catch {
    // The probe only needed to open.
  }
  return true
}

// Lock held: the transfer of a `partial` entry, or BlobNotFoundError.
async function requireTransfer(ctx: TransferContext, blobID: string): Promise<ActiveTransfer> {
  const store = await getBlobStore(ctx.db)
  const entry = await store.getEntry(blobID)
  const transfer = entry?.state === 'partial' ? await store.getTransfer(blobID) : null
  if (entry === null || transfer === null) {
    throw new BlobNotFoundError(blobID, { cause: new Error('No active transfer') })
  }
  return { store, entry, transfer, digests: await store.getChunkDigests(blobID) }
}

export async function beginFetch(
  ctx: TransferContext,
  id: string,
  manifest: TransferManifest,
): Promise<void> {
  const blobID = ctx.codec.canonicalize(id)
  const contentType = validateManifest(ctx, blobID, manifest)
  // A zero-length blob has no chunks, so the peer's chunk size is meaningless.
  const chunkSize = manifest.contentLength === 0 ? ctx.chunkSize : manifest.chunkSize
  await ctx.lock.withLock(blobID, async () => {
    const store = await getBlobStore(ctx.db)
    const entry = await store.getEntry(blobID)
    if (entry?.state === 'local') return
    // A stub with another length could never complete against this manifest.
    if (entry !== null && entry.contentLength !== manifest.contentLength) {
      throw new InvalidManifestError(
        `contentLength ${manifest.contentLength} does not match the stored entry (${entry.contentLength})`,
      )
    }

    const transfer = entry === null ? null : await store.getTransfer(blobID)
    if (entry !== null && transfer !== null) {
      const identical =
        entry.state === 'partial' &&
        entry.chunkSize === chunkSize &&
        digestsEqual(await store.getChunkDigests(blobID), manifest.chunks)
      if (identical && (await stagingExists(ctx.backend, transfer, entry.chunkSize))) {
        await store.touchTransfer(blobID)
        return
      }
      await abortQuietly(ctx.backend, transfer.stagingID)
    }

    if (entry === null) {
      await store.insertEntry(
        {
          blobID,
          contentLength: manifest.contentLength,
          encrypted: manifest.encrypted ?? false,
          keyID: manifest.keyID ?? null,
          chunkSize,
          state: 'remote-only',
          createdAt: Date.now(),
          contentType: contentType ?? null,
        },
        [],
      )
    } else {
      // Drops the previous manifest and progress so the new manifest replaces them.
      await store.resetTransfer(blobID)
      if (contentType !== undefined) await store.fillContentType(blobID, contentType)
    }
    const chunks = manifest.chunks.map((digest, index) => ({ index, digest }))
    await store.beginTransfer(blobID, chunkSize, chunks, createStagingID('t'))
  })
}

export async function getPresentChunks(ctx: TransferContext, id: string): Promise<Array<number>> {
  const blobID = ctx.codec.canonicalize(id)
  return await ctx.lock.withLock(blobID, async () => {
    const store = await getBlobStore(ctx.db)
    const entry = await store.getEntry(blobID)
    if (entry?.state !== 'partial') return []
    const transfer = await store.getTransfer(blobID)
    if (transfer === null) return []
    if (!(await stagingExists(ctx.backend, transfer, entry.chunkSize))) {
      await store.resetTransfer(blobID)
      return []
    }
    return transfer.presentChunks
  })
}

export async function stageChunk(
  ctx: TransferContext,
  id: string,
  index: number,
  bytes: Uint8Array,
): Promise<void> {
  const blobID = ctx.codec.canonicalize(id)
  await ctx.lock.withLock(blobID, async () => {
    const { store, entry, transfer, digests } = await requireTransfer(ctx, blobID)
    if (!Number.isSafeInteger(index) || index < 0 || index >= digests.length) {
      throw new InvalidManifestError(`chunk index ${index} is outside [0, ${digests.length})`)
    }
    const expectedLength = chunkLength(entry, digests.length, index)
    if (bytes.length !== expectedLength) {
      throw new ChunkLengthError(blobID, index, expectedLength, bytes.length)
    }
    const hasher = ctx.codec.createHasher()
    hasher.update(bytes)
    if (!bytesEqual(hasher.digest(), digests[index] as Uint8Array)) {
      throw new ChunkDigestMismatchError(blobID, index)
    }
    await ctx.backend.writeChunk(transfer.stagingID, index * entry.chunkSize, bytes)
    await store.recordTransferChunk(blobID, index)
  })
}

// Streams staged bytes through the hasher; never buffers the whole blob.
async function hashStaging(
  ctx: TransferContext,
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ digest: Uint8Array; length: number }> {
  const reader = stream.getReader()
  const hasher = ctx.codec.createHasher()
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      // Already a mismatch; stop reading.
      if (length > limit) {
        await reader.cancel()
        break
      }
      hasher.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return { digest: hasher.digest(), length }
}

export async function completeFetch(ctx: TransferContext, id: string): Promise<BlobEntry> {
  const blobID = ctx.codec.canonicalize(id)
  return await ctx.lock.withLock(blobID, async () => {
    const { store, entry, transfer, digests } = await requireTransfer(ctx, blobID)
    const present = new Set(transfer.presentChunks)
    const missing = digests.length - digests.filter((_, index) => present.has(index)).length
    if (missing > 0) {
      throw new TransferIncompleteError(blobID, missing)
    }
    // A zero-length blob stages no chunks; materialize its empty area for commit.
    if (digests.length === 0) {
      await ctx.backend.writeChunk(transfer.stagingID, 0, new Uint8Array(0))
    }

    const expected = ctx.codec.decode(blobID)
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await ctx.backend.createStagingReadStream(transfer.stagingID)
    } catch (cause) {
      // The staging area vanished: the caller must begin again.
      await store.resetTransfer(blobID)
      throw new BlobNotFoundError(blobID, { cause })
    }
    const hashed = await hashStaging(ctx, stream, expected.contentLength)
    if (hashed.length !== expected.contentLength || !bytesEqual(hashed.digest, expected.digest)) {
      await abortQuietly(ctx.backend, transfer.stagingID)
      await store.resetTransfer(blobID)
      const actual = ctx.codec.encode({
        digest: hashed.digest,
        contentLength: hashed.length,
        ...(expected.contentType === undefined ? {} : { contentType: expected.contentType }),
      })
      throw new BlobIDMismatchError(blobID, actual)
    }

    // Verified: bytes are committed before the row.
    await ctx.backend.commit(transfer.stagingID, blobID)
    await store.promoteEntry(
      {
        blobID,
        contentLength: entry.contentLength,
        encrypted: entry.encrypted,
        keyID: entry.keyID,
        chunkSize: entry.chunkSize,
        pinned: entry.pinned,
        createdAt: entry.createdAt,
        contentType: entry.contentType,
      },
      digests.map((digest, index) => ({ index, digest })),
    )
    const promoted = await store.getEntry(blobID)
    if (promoted === null) throw new Error(`Blob entry ${blobID} missing after promotion`)
    return promoted
  })
}
