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

export class BlobIDMismatchError extends Error {
  constructor(expected: string, actual: string, options?: ErrorOptions) {
    super(`Blob ID mismatch: expected ${expected}, got ${actual}`, options)
    this.name = 'BlobIDMismatchError'
  }
}

export class ContentTypeMismatchError extends Error {
  constructor(expected: string, actual: string, options?: ErrorOptions) {
    super(
      `Content type mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      options,
    )
    this.name = 'ContentTypeMismatchError'
  }
}

export class ChunkDigestMismatchError extends Error {
  constructor(id: string, index: number, options?: ErrorOptions) {
    super(`Chunk ${index} of blob ${id} does not match its manifest digest`, options)
    this.name = 'ChunkDigestMismatchError'
  }
}

export class ChunkLengthError extends Error {
  constructor(id: string, index: number, expected: number, actual: number, options?: ErrorOptions) {
    super(`Chunk ${index} of blob ${id} must be ${expected} bytes, got ${actual}`, options)
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
