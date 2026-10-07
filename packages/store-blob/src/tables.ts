import type { BlobState } from './types.js'

export type BlobEntryTable = {
  blob_id: string
  content_length: number
  // Integer flags keep the representation portable across adapters.
  encrypted: number
  key_id: string | null
  chunk_size: number
  state: BlobState
  pinned: number
  created_at: number
}

// The manifest survives finalisation for range verification.
export type BlobChunkTable = {
  blob_id: string
  index: number
  digest: Uint8Array
}

// Present chunks for an in-flight transfer. Purged on finalisation.
export type BlobTransferTable = {
  blob_id: string
  index: number
}

export type BlobTables = {
  blob_entries: BlobEntryTable
  blob_chunks: BlobChunkTable
  blob_transfers: BlobTransferTable
}
