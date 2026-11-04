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
  content_type: string | null
}

// The manifest survives finalisation for range verification.
export type BlobChunkTable = {
  blob_id: string
  index: number
  digest: Uint8Array
}

export type BlobFetchSessionTable = {
  blob_id: string
  owner: string
  staging_id: string
  content_length: number
  chunk_size: number
  content_type: string | null
  encrypted: number
  key_id: string | null
  created_at: number
  updated_at: number
}
export type BlobFetchChunkTable = {
  staging_id: string
  index: number
  digest: Uint8Array
  present: number
}

export type BlobByteDeletionTable = { blob_id: string; queued_at: number }

export type BlobRefTable = { blob_id: string; kind: string; key: string; created_at: number }
export type BlobReleaseTable = { blob_id: string; released_at: number }

export type BlobByteDeletionTable = { blob_id: string; queued_at: number }

export type BlobRefTable = { blob_id: string; kind: string; key: string; created_at: number }
export type BlobReleaseTable = { blob_id: string; released_at: number }

export type BlobTables = {
  blob_refs: BlobRefTable
  blob_releases: BlobReleaseTable
  blob_byte_deletions: BlobByteDeletionTable
  blob_entries: BlobEntryTable
  blob_chunks: BlobChunkTable
  blob_fetch_sessions: BlobFetchSessionTable
  blob_fetch_chunks: BlobFetchChunkTable
}
