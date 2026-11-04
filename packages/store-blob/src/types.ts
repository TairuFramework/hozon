import type { BatchReadOptions } from '@hozon/db'

export type BlobState = 'local' | 'partial' | 'remote-only'

export type BlobEntryInput = {
  blobID: string
  contentLength: number
  encrypted?: boolean
  keyID?: string | null
  chunkSize: number
  state: BlobState
  pinned?: boolean
  createdAt: number
  contentType?: string | null
}

export type BlobChunkInput = {
  index: number
  digest: Uint8Array
}

export type BlobEntry = {
  blobID: string
  contentLength: number
  encrypted: boolean
  keyID: string | null
  chunkSize: number
  state: BlobState
  pinned: boolean
  createdAt: number
  contentType: string | null
}

export type BeginTransferParams = {
  blobID: string
  chunkSize: number
  chunks: Array<BlobChunkInput>
  stagingID: string
}

export type BlobTransfer = {
  stagingID: string
  updatedAt: number
  presentChunks: Array<number>
}

// Persists metadata and transfer progress. Callers own byte storage and verification.
export type BlobByteDeletion = { blobID: string; queuedAt: number }

export type BlobStoreAPI = {
  // Call under `withBlobLocks`.
  enqueueByteDeletion(blobID: string, queuedAt?: number): Promise<void>
  listByteDeletions(params?: { limit?: number }): Promise<Array<BlobByteDeletion>>
  // Call under `withBlobLocks`.
  deleteByteDeletion(blobID: string): Promise<void>
  // Call under `withBlobLocks`.
  insertEntry(entry: BlobEntryInput, chunks: Array<BlobChunkInput>): Promise<void>
  getEntry(blobID: string): Promise<BlobEntry | null>
  // Reads fresh rows in one query; never uses the batched or remembered `getEntry` values.
  getEntries(
    blobIDs: Array<string>,
    options?: BatchReadOptions,
  ): Promise<Map<string, BlobEntry | null>>
  getChunkDigests(blobID: string): Promise<Array<Uint8Array>>
  // Call under `withBlobLocks`.
  setPinned(blobID: string, pinned: boolean): Promise<void>
  // Call under `withBlobLocks`.
  deleteEntry(blobID: string): Promise<void>
  // Call under `withBlobLocks`.
  beginTransfer(params: BeginTransferParams): Promise<void>
  // Call under `withBlobLocks`.
  recordTransferChunk(blobID: string, index: number): Promise<void>
  getPresentChunkIndexes(blobID: string): Promise<Array<number>>
  // Call under `withBlobLocks`.
  finalizeTransfer(blobID: string): Promise<void>
  getTransfer(blobID: string): Promise<BlobTransfer | null>
  getTransferByStagingID(stagingID: string): Promise<{ blobID: string; updatedAt: number } | null>
  // Call under `withBlobLocks`.
  touchTransfer(blobID: string): Promise<void>
  listEntries(params: {
    limit: number
    cursor?: string
  }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>
  // Call under `withBlobLocks`.
  promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>
  // Call under `withBlobLocks`.
  resetTransfer(blobID: string): Promise<void>
  // Sets the content type only when the stored one is null.
  // Call under `withBlobLocks`.
  fillContentType(blobID: string, contentType: string): Promise<void>
}
