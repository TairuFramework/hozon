export class BlobNotFoundError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Blob not found: ${id}`, options)
    this.name = 'BlobNotFoundError'
  }
}

export class BlobTooLargeError extends Error {
  constructor(limit: number, options?: ErrorOptions) {
    super(`Blob exceeds the size limit of ${limit} bytes`, options)
    this.name = 'BlobTooLargeError'
  }
}

export type BlobIDMismatchErrorParams = { expected: string; actual: string }

export class BlobIDMismatchError extends Error {
  constructor(params: BlobIDMismatchErrorParams, options?: ErrorOptions) {
    super(`Blob ID mismatch: expected ${params.expected}, got ${params.actual}`, options)
    this.name = 'BlobIDMismatchError'
  }
}

export type ContentTypeMismatchErrorParams = { expected: string; actual: string }

export class ContentTypeMismatchError extends Error {
  constructor(params: ContentTypeMismatchErrorParams, options?: ErrorOptions) {
    super(
      `Content type mismatch: expected ${JSON.stringify(params.expected)}, got ${JSON.stringify(params.actual)}`,
      options,
    )
    this.name = 'ContentTypeMismatchError'
  }
}

export type ChunkDigestMismatchErrorParams = { id: string; index: number }

export class ChunkDigestMismatchError extends Error {
  constructor(params: ChunkDigestMismatchErrorParams, options?: ErrorOptions) {
    super(`Chunk ${params.index} of blob ${params.id} does not match its manifest digest`, options)
    this.name = 'ChunkDigestMismatchError'
  }
}

export type ChunkLengthErrorParams = { id: string; index: number; expected: number; actual: number }

export class ChunkLengthError extends Error {
  constructor(params: ChunkLengthErrorParams, options?: ErrorOptions) {
    super(
      `Chunk ${params.index} of blob ${params.id} must be ${params.expected} bytes, got ${params.actual}`,
      options,
    )
    this.name = 'ChunkLengthError'
  }
}

export class InvalidManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid manifest: ${message}`, options)
    this.name = 'InvalidManifestError'
  }
}

export class InvalidRangeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid range: ${message}`, options)
    this.name = 'InvalidRangeError'
  }
}

export class BlobWriteAbortedError extends Error {
  constructor(message = 'Blob write aborted', options?: ErrorOptions) {
    super(message, options)
    this.name = 'BlobWriteAbortedError'
  }
}

export type TransferIncompleteErrorParams = { id: string; missing: number }

export class TransferIncompleteError extends Error {
  constructor(params: TransferIncompleteErrorParams, options?: ErrorOptions) {
    super(`Cannot complete transfer of ${params.id}: ${params.missing} chunk(s) missing`, options)
    this.name = 'TransferIncompleteError'
  }
}
