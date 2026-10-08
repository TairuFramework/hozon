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

export type BlobTransfer = {
  stagingID: string
  updatedAt: number
  presentChunks: Array<number>
}

// Persists metadata and transfer progress. Callers own byte storage and verification.
export type BlobStoreAPI = {
  insertEntry(entry: BlobEntryInput, chunks: Array<BlobChunkInput>): Promise<void>
  getEntry(blobID: string): Promise<BlobEntry | null>
  getChunkDigests(blobID: string): Promise<Array<Uint8Array>>
  setPinned(blobID: string, pinned: boolean): Promise<void>
  deleteEntry(blobID: string): Promise<void>
  beginTransfer(
    blobID: string,
    chunkSize: number,
    chunks: Array<BlobChunkInput>,
    stagingID: string,
  ): Promise<void>
  recordTransferChunk(blobID: string, index: number): Promise<void>
  getPresentChunkIndexes(blobID: string): Promise<Array<number>>
  finalizeTransfer(blobID: string): Promise<void>
  getTransfer(blobID: string): Promise<BlobTransfer | null>
  getTransferByStagingID(stagingID: string): Promise<{ blobID: string; updatedAt: number } | null>
  touchTransfer(blobID: string): Promise<void>
  listEntries(params: {
    limit: number
    cursor?: string
  }): Promise<{ entries: Array<BlobEntry>; nextCursor: string | null }>
  promoteEntry(entry: Omit<BlobEntryInput, 'state'>, chunks: Array<BlobChunkInput>): Promise<void>
  resetTransfer(blobID: string): Promise<void>
}
