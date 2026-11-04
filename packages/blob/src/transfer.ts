import type { BlobBackend } from '@hozon/blob-backend'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry, BlobSession, BlobStoreAPI } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'

import {
  BlobIDMismatchError,
  ChunkDigestMismatchError,
  ChunkLengthError,
  InvalidManifestError,
  StagingLimitError,
  TransferIncompleteError,
  TransferNotFoundError,
} from './errors.js'
import { getFreshEntry } from './fresh.js'
import { lockBlobs } from './locking.js'
import { afterCommit, reclaimOnRollback } from './manage.js'
import { commitStaging } from './publish.js'
import type { WriteContext } from './write.js'
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

export type TransferKey = { id: string; owner: string }
export type BeginFetchParams = TransferKey & { manifest: TransferManifest }
export type BeginFetchResult =
  | { status: 'local' }
  | { status: 'started' | 'resumed' | 'restarted'; presentChunks: Array<number> }
export type StageChunkParams = TransferKey & { index: number; bytes: Uint8Array }
export type CompleteFetchResult = { entry: BlobEntry; fetched: boolean }
export type BlobTransferInfo = {
  blobID: string
  owner: string
  chunkSize: number
  chunkCount: number
  presentCount: number
  createdAt: number
  updatedAt: number
}
export type ListTransfersParams = {
  owner?: string
  ownerPrefix?: string
  blobID?: string
  limit: number
  cursor?: string
}
export type TransferContext = WriteContext

function validateOwner(owner: string): void {
  if (typeof owner !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(owner))
    throw new Error('Owner must be printable ASCII, 1 to 255 characters')
}
function transferKey(ctx: TransferContext, key: TransferKey): string {
  validateOwner(key.owner)
  return ctx.codec.canonicalize(key.id)
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
function chunkLength(
  entry: { chunkSize: number; contentLength: number },
  count: number,
  index: number,
): number {
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
  transfer: BlobSession,
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

async function missing(store: BlobStoreAPI, blobID: string, owner: string) {
  return new TransferNotFoundError({
    id: blobID,
    owner,
    blobState: (await getFreshEntry(store, blobID))?.state ?? null,
  })
}

export async function beginFetch(
  ctx: TransferContext,
  params: BeginFetchParams,
): Promise<BeginFetchResult> {
  const blobID = transferKey(ctx, params)
  const { owner, manifest } = params
  const cleanups: Array<Promise<boolean>> = []
  const result = await lockBlobs(ctx.db, [blobID], async (tx): Promise<BeginFetchResult> => {
    const store = await getBlobStore(tx)
    const entry = await getFreshEntry(store, blobID)
    const session = await store.getSession(blobID, owner)
    if (entry?.state === 'local') {
      if (session !== null) {
        await store.deleteSession(blobID, owner)
        cleanups.push(awaitEnd(session))
      }
      return { status: 'local' }
    }
    const contentType = validateManifest(ctx, blobID, manifest) ?? null
    const chunkSize =
      manifest.contentLength > 0 || entry?.state === 'remote' ? manifest.chunkSize : ctx.chunkSize
    if (entry !== null && entry.contentLength !== manifest.contentLength)
      throw new InvalidManifestError('contentLength differs from the stored entry')
    if (
      entry?.state === 'remote' &&
      entry.chunkSize === chunkSize &&
      !digestsEqual(await store.getChunkDigests(blobID), manifest.chunks)
    )
      throw new InvalidManifestError('digests differ from the verified layout')
    if (
      session !== null &&
      session.chunkSize === chunkSize &&
      session.contentType === contentType &&
      session.encrypted === (manifest.encrypted ?? false) &&
      session.keyID === (manifest.keyID ?? null) &&
      digestsEqual(
        session.chunks.map((c) => c.digest),
        manifest.chunks,
      ) &&
      (await stagingExists(ctx.backend, session, chunkSize))
    ) {
      await store.touchSession(blobID, owner)
      return { status: 'resumed', presentChunks: session.presentChunks }
    }
    if (
      ctx.limits.maxStagingBytes !== undefined &&
      (await store.sumSessionContentLength()) +
        [...ctx.activeWrites.values()].reduce((sum, bytes) => sum + bytes, 0) +
        manifest.contentLength >
        ctx.limits.maxStagingBytes
    )
      throw new StagingLimitError()
    if (entry === null) {
      await store.insertEntry(
        {
          blobID,
          contentLength: manifest.contentLength,
          chunkSize,
          state: 'remote-only',
          createdAt: Date.now(),
          contentType,
          encrypted: manifest.encrypted ?? false,
          keyID: manifest.keyID ?? null,
        },
        [],
      )
    }
    if (session !== null) cleanups.push(awaitEnd(session))
    const stagingID = createStagingID(ctx.runtime, 't')
    ctx.activeWrites.set(stagingID, 0)
    tx.onCommit(() => {
      ctx.activeWrites.delete(stagingID)
    })
    tx.onRollback(() => {
      ctx.activeWrites.delete(stagingID)
      void abortQuietly(ctx.backend, stagingID)
    })
    await store.putSession({
      blobID,
      owner,
      stagingID,
      contentLength: manifest.contentLength,
      chunkSize,
      contentType,
      encrypted: manifest.encrypted ?? false,
      keyID: manifest.keyID ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      chunks: manifest.chunks.map((digest, index) => ({ index, digest, present: false })),
    })
    return { status: session === null ? 'started' : 'restarted', presentChunks: [] }
    function awaitEnd(old: BlobSession): Promise<boolean> {
      // Register cleanup synchronously; do not await a commit hook inside its transaction.
      return afterCommit(ctx, tx, () => abortQuietly(ctx.backend, old.stagingID))
    }
  })
  if (!ctx.db.isTransactionBound) await Promise.all(cleanups)
  return result
}

export async function getPresentChunks(
  ctx: TransferContext,
  key: TransferKey,
): Promise<Array<number>> {
  const blobID = transferKey(ctx, key)
  return await lockBlobs(ctx.db, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    const session = await store.getSession(blobID, key.owner)
    if (session === null) return []
    if (!(await stagingExists(ctx.backend, session, session.chunkSize))) {
      await store.deleteSession(blobID, key.owner)
      return []
    }
    return session.presentChunks
  })
}

export async function stageChunk(ctx: TransferContext, params: StageChunkParams): Promise<void> {
  const blobID = transferKey(ctx, params)
  const { owner, index, bytes } = params
  async function prepare(provider: StoreProvider): Promise<BlobSession> {
    const store = await getBlobStore(provider)
    const session = await store.getSession(blobID, owner)
    if (session === null) throw await missing(store, blobID, owner)
    if (!Number.isSafeInteger(index) || index < 0 || index >= session.chunks.length)
      throw new InvalidManifestError('chunk index outside the manifest')
    const expectedLength = chunkLength(session, session.chunks.length, index)
    if (bytes.length !== expectedLength)
      throw new ChunkLengthError({
        id: blobID,
        index,
        expected: expectedLength,
        actual: bytes.length,
      })
    const hasher = ctx.codec.createHasher()
    hasher.update(bytes)
    if (!bytesEqual(hasher.digest(), (session.chunks[index] as { digest: Uint8Array }).digest))
      throw new ChunkDigestMismatchError({ id: blobID, index })
    await ctx.backend.writeChunk(session.stagingID, index * session.chunkSize, bytes)
    return session
  }
  const prepared = ctx.db.isTransactionBound ? undefined : await prepare(ctx.db)
  let cleanup: Promise<boolean> | undefined
  const error = await lockBlobs(ctx.db, [blobID], async (tx) => {
    const session = prepared ?? (await prepare(tx))
    const store = await getBlobStore(tx)
    if ((await store.getSession(blobID, owner))?.stagingID !== session.stagingID) {
      cleanup = afterCommit(ctx, tx, () => abortQuietly(ctx.backend, session.stagingID))
      return await missing(store, blobID, owner)
    }
    await store.markSessionChunk(blobID, owner, index)
    return null
  })
  if (!ctx.db.isTransactionBound) await cleanup
  if (error !== null) throw error
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

export async function completeFetch(
  ctx: TransferContext,
  key: TransferKey,
): Promise<CompleteFetchResult> {
  const blobID = transferKey(ctx, key)
  const { owner } = key
  const expected = ctx.codec.decode(blobID)
  async function prepare(provider: StoreProvider) {
    const store = await getBlobStore(provider)
    const session = await store.getSession(blobID, owner)
    if (session === null) return { session, hashed: null }
    const missingCount = session.chunks.length - session.presentChunks.length
    if (missingCount > 0) throw new TransferIncompleteError({ id: blobID, missing: missingCount })
    if (session.chunks.length === 0)
      await ctx.backend.writeChunk(session.stagingID, 0, new Uint8Array())
    try {
      return {
        session,
        hashed: await hashStaging(
          ctx,
          await ctx.backend.createStagingReadStream(session.stagingID),
          expected.contentLength,
        ),
      }
    } catch {
      return { session, hashed: null }
    }
  }
  const prepared = ctx.db.isTransactionBound ? undefined : await prepare(ctx.db)
  const cleanups: Array<Promise<boolean>> = []
  const result = await lockBlobs(ctx.db, [blobID], async (tx, originalError) => {
    const { session, hashed } = prepared ?? (await prepare(tx))
    const store = await getBlobStore(tx)
    const entry = await getFreshEntry(store, blobID)
    const current = await store.getSession(blobID, owner)
    if (entry?.state === 'local') {
      if (session !== null && session.stagingID !== current?.stagingID)
        cleanups.push(afterCommit(ctx, tx, () => abortQuietly(ctx.backend, session.stagingID)))
      if (current !== null) {
        await store.deleteSession(blobID, owner)
        cleanups.push(afterCommit(ctx, tx, () => abortQuietly(ctx.backend, current.stagingID)))
      }
      return { entry, fetched: false }
    }
    if (session === null || current?.stagingID !== session.stagingID) {
      if (session !== null)
        cleanups.push(afterCommit(ctx, tx, () => abortQuietly(ctx.backend, session.stagingID)))
      return { error: await missing(store, blobID, owner) }
    }
    if (
      hashed === null ||
      hashed.length !== expected.contentLength ||
      !bytesEqual(hashed.digest, expected.digest)
    ) {
      await store.deleteSession(blobID, owner)
      cleanups.push(afterCommit(ctx, tx, () => abortQuietly(ctx.backend, session.stagingID)))
      if (hashed === null) return { error: await missing(store, blobID, owner) }
      return {
        error: new BlobIDMismatchError({
          expected: blobID,
          actual: ctx.codec.encode({
            digest: hashed.digest,
            contentLength: hashed.length,
            ...(expected.contentType === undefined ? {} : { contentType: expected.contentType }),
          }),
        }),
      }
    }
    if (entry === null) return { error: await missing(store, blobID, owner) }
    const sessions = await allSessions(store, blobID)
    const publish = async (provider: StoreProvider) => {
      const target = await getBlobStore(provider)
      await target.promoteEntry(
        {
          ...entry,
          chunkSize: session.chunkSize,
          contentType: entry.contentType ?? session.contentType,
          keyID: entry.keyID ?? session.keyID,
        },
        session.chunks.map(({ index, digest }) => ({ index, digest })),
      )
      if (ctx.db.isTransactionBound) reclaimOnRollback(ctx, provider, blobID)
      const promoted = await getFreshEntry(target, blobID)
      if (promoted === null) throw new Error('Missing promoted entry')
      for (const ended of sessions)
        cleanups.push(afterCommit(ctx, provider, () => abortQuietly(ctx.backend, ended.stagingID)))
      await commitStaging(ctx.backend, session.stagingID, blobID, originalError)
      return { entry: promoted, fetched: true }
    }
    if (ctx.db.isTransactionBound) {
      if (tx.withSavepoint === undefined)
        throw new Error('Blob publication requires savepoint support')
      return await tx.withSavepoint(publish)
    }
    return await publish(tx)
  })
  if (!ctx.db.isTransactionBound) await Promise.all(cleanups)
  if ('error' in result) throw result.error
  return result
}

export async function allSessions(
  store: BlobStoreAPI,
  blobID: string,
): Promise<Array<BlobSession>> {
  const sessions: Array<BlobSession> = []
  let cursor: string | undefined
  do {
    const page = await store.listSessions({ blobID, limit: 500, cursor })
    sessions.push(...page.sessions)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return sessions
}

export async function abortFetch(ctx: TransferContext, key: TransferKey): Promise<boolean> {
  const blobID = transferKey(ctx, key)
  let cleanup: Promise<boolean> | undefined
  const ended = await lockBlobs(ctx.db, [blobID], async (tx) => {
    const store = await getBlobStore(tx)
    const session = await store.getSession(blobID, key.owner)
    if (session === null) return false
    await store.deleteSession(blobID, key.owner)
    cleanup = afterCommit(ctx, tx, () => abortQuietly(ctx.backend, session.stagingID))
    return true
  })
  if (!ctx.db.isTransactionBound) await cleanup
  return ended
}

export async function listTransfers(
  ctx: TransferContext,
  params: ListTransfersParams,
): Promise<{ transfers: Array<BlobTransferInfo>; nextCursor: string | null }> {
  if (params.owner !== undefined) validateOwner(params.owner)
  if (params.ownerPrefix !== undefined) validateOwner(params.ownerPrefix)
  if (params.owner !== undefined && params.ownerPrefix !== undefined)
    throw new Error('Choose owner or ownerPrefix')
  const page = await (await getBlobStore(ctx.db)).listSessions({
    ...params,
    ...(params.blobID === undefined ? {} : { blobID: ctx.codec.canonicalize(params.blobID) }),
  })
  return {
    transfers: page.sessions.map((s) => ({
      blobID: s.blobID,
      owner: s.owner,
      chunkSize: s.chunkSize,
      chunkCount: s.chunks.length,
      presentCount: s.presentChunks.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    nextCursor: page.nextCursor,
  }
}

export async function abortFetches(
  ctx: TransferContext,
  selector: { owner: string } | { ownerPrefix: string },
): Promise<number> {
  let cursor: string | undefined
  let count = 0
  do {
    const page = await listTransfers(ctx, { ...selector, limit: 500, cursor })
    for (const transfer of page.transfers)
      if (await abortFetch(ctx, { id: transfer.blobID, owner: transfer.owner })) count++
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return count
}
