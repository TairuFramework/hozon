export type BlobLimits = {
  maxBlobSize: number
  maxChunkSize: number
  minChunkSize: number
}

export const DEFAULT_CHUNK_SIZE = 1024 * 1024

export const DEFAULT_LIMITS: BlobLimits = {
  maxBlobSize: 1024 * 1024 * 1024,
  maxChunkSize: 16 * 1024 * 1024,
  minChunkSize: 1024,
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export function resolveLimits(limits: Partial<BlobLimits> = {}): BlobLimits {
  const resolved: BlobLimits = {
    maxBlobSize: limits.maxBlobSize ?? DEFAULT_LIMITS.maxBlobSize,
    maxChunkSize: limits.maxChunkSize ?? DEFAULT_LIMITS.maxChunkSize,
    minChunkSize: limits.minChunkSize ?? DEFAULT_LIMITS.minChunkSize,
  }
  if (
    !Number.isSafeInteger(resolved.maxBlobSize) ||
    resolved.maxBlobSize < 0 ||
    !isPositiveInteger(resolved.minChunkSize) ||
    !isPositiveInteger(resolved.maxChunkSize) ||
    resolved.minChunkSize > resolved.maxChunkSize
  ) {
    throw new Error('Invalid limits')
  }
  return resolved
}

export function assertChunkSize(chunkSize: number, limits: BlobLimits): void {
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < limits.minChunkSize ||
    chunkSize > limits.maxChunkSize
  ) {
    throw new Error('Invalid chunkSize')
  }
}
