import type { BatchReadOptions } from '@hozon/db'

export type BlobState = 'local' | 'remote' | 'remote-only'

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

export type BlobSessionInput = {
  blobID: string
  owner: string
  stagingID: string
  contentLength: number
  chunkSize: number
  contentType: string | null
  encrypted: boolean
  keyID: string | null
  createdAt: number
  updatedAt: number
  chunks: Array<BlobChunkInput>
}
export type BlobSession = Omit<BlobSessionInput, 'chunks'> & {
  chunks: Array<BlobChunkInput & { present: boolean }>
  presentChunks: Array<number>
}
export type ListSessionsParams = {
  owner?: string
  ownerPrefix?: string
  blobID?: string
  limit: number
  cursor?: string
}

// Persists metadata and transfer progress. Callers own byte storage and verification.
export type BlobByteDeletion = { blobID: string; queuedAt: number }

export type BlobHolder = { kind: string; key: string }
export type BlobRefInput = BlobHolder & { blobID: string }
export type BlobRef = BlobRefInput & { createdAt: number }
export type BlobHolderSelector = { kind: string; key: string } | { kind: string; keyPrefix: string }
export type FindRefsParams = {
  kind: string
  key?: string
  keyPrefix?: string
  blobID?: string
  limit: number
  cursor?: string
}
export type BlobRelease = { blobID: string; releasedAt: number }

export type BlobStoreAPI = {
  // Call under `withBlobLocks`.
  insertRefs(refs: Array<BlobRefInput>): Promise<void>
  // Removal and release updates share a transaction; removal needs no blob lock.
  deleteRefs(refs: Array<BlobRefInput>): Promise<Array<string>>
  deleteRefsByHolder(selector: BlobHolderSelector): Promise<Array<string>>
  countRefs(blobID: string): Promise<number>
  listRefs(blobID: string): Promise<Array<BlobRef>>
  findRefs(params: FindRefsParams): Promise<{ refs: Array<BlobRef>; nextCursor: string | null }>
  // Call under `withBlobLocks`, or in the transaction removing refs.
  upsertReleases(blobIDs: Array<string>, releasedAt?: number): Promise<void>
  listReleases(params: {
    releasedBefore: Date
    limit?: number
    blobID?: string
    forUpdate?: boolean
  }): Promise<Array<BlobRelease>>
  // Call under `withBlobLocks`.
  deleteRelease(blobID: string): Promise<void>
  // Call under `withBlobLocks`.
  setState(blobID: string, state: BlobState): Promise<void>
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
  getSession(blobID: string, owner: string): Promise<BlobSession | null>
  getSessionByStagingID(stagingID: string): Promise<BlobSession | null>
  listSessions(
    params: ListSessionsParams,
  ): Promise<{ sessions: Array<BlobSession>; nextCursor: string | null }>
  // Call under `withBlobLocks`.
  putSession(session: BlobSessionInput): Promise<void>
  // Call under `withBlobLocks`.
  markSessionChunk(blobID: string, owner: string, index: number): Promise<void>
  // Call under `withBlobLocks`.
  deleteSession(blobID: string, owner: string): Promise<void>
  // Call under `withBlobLocks`.
  deleteSessions(blobID: string): Promise<void>
  // Call under `withBlobLocks`.
  touchSession(blobID: string, owner: string): Promise<void>
  sumSessionContentLength(): Promise<number>
  listEntries(params: {
    limit: number
    cursor?: string
  }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>
  // Call under `withBlobLocks`.
  promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>
  // Sets the content type only when the stored one is null.
  // Call under `withBlobLocks`.
  fillContentType(blobID: string, contentType: string): Promise<void>
}
