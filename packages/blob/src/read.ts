import type { BlobBackend, BlobRange } from '@hozon/blob-backend'
import type { BlobIDCodec } from '@hozon/blob-id'
import type { StoreProvider } from '@hozon/db'
import type { BlobEntry } from '@hozon/store-blob'
import { getBlobStore } from '@hozon/store-blob'

import { BlobNotFoundError, InvalidRangeError } from './errors.js'

export type ReadContext = {
  db: StoreProvider
  backend: BlobBackend
  codec: BlobIDCodec
}

export async function getEntry(ctx: ReadContext, id: string): Promise<BlobEntry | null> {
  const store = await getBlobStore(ctx.db)
  return await store.getEntry(ctx.codec.canonicalize(id))
}

export async function listEntries(
  ctx: ReadContext,
  params: { limit: number; cursor?: string },
): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }> {
  const store = await getBlobStore(ctx.db)
  return await store.listEntries(params)
}

export async function hasBlob(ctx: ReadContext, id: string): Promise<boolean> {
  return (await getEntry(ctx, id))?.state === 'local'
}

export async function getChunkDigests(ctx: ReadContext, id: string): Promise<Array<Uint8Array>> {
  const blobID = ctx.codec.canonicalize(id)
  const store = await getBlobStore(ctx.db)
  // Digests of non-local entries come from an unverified peer manifest.
  const entry = await store.getEntry(blobID)
  if (entry?.state !== 'local') return []
  return await store.getChunkDigests(blobID)
}

export async function createBlobReadStream(
  ctx: ReadContext,
  id: string,
  range?: BlobRange,
): Promise<ReadableStream<Uint8Array>> {
  const blobID = ctx.codec.canonicalize(id)
  const store = await getBlobStore(ctx.db)
  const entry = await store.getEntry(blobID)
  if (entry === null || entry.state !== 'local') throw new BlobNotFoundError(blobID)
  if (range !== undefined) {
    const { start, end } = range
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      throw new InvalidRangeError(`bytes ${start}-${end}`)
    }
    if (end >= entry.contentLength) {
      throw new InvalidRangeError(`end ${end} is beyond content length ${entry.contentLength}`)
    }
  }
  return await ctx.backend.createReadStream(blobID, range)
}
