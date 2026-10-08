export type BlobIDInfo = {
  digest: Uint8Array
  contentLength: number
  contentType?: string
}

export type BlobHasher = {
  update(bytes: Uint8Array): void
  digest(): Uint8Array
}

export type BlobIDCodec = {
  digestLength: number
  createHasher(): BlobHasher
  encode(info: BlobIDInfo): string
  decode(id: string): BlobIDInfo
  canonicalize(id: string): string
}

export type HashResult = {
  digest: Uint8Array
  contentLength: number
  chunks: Array<Uint8Array>
}

export const BLOB_ID_ALPHABET = /^[a-z0-9_-]+$/
