import { BatchLimitError } from './errors.js'
import { chunk } from './keep-set.js'

export type BatchReadOptions = { batchLimit?: number }

export type IterateBatchesOptions = { batchSize: number; signal?: AbortSignal }

/** Throws if `size` exceeds `batchLimit ?? max`, or if `batchLimit` is invalid or above `max`. */
export function assertBatchSize(size: number, max: number, batchLimit?: number): void {
  if (
    batchLimit != null &&
    (!Number.isInteger(batchLimit) || batchLimit <= 0 || batchLimit > max)
  ) {
    throw new RangeError(`batchLimit must be a positive integer no greater than ${max}`)
  }
  const limit = batchLimit ?? max
  if (size > limit) throw new BatchLimitError(size, limit)
}

/**
 * Dedupes `keys`, loads them in sequential chunks of `batchSize` and yields each chunk with
 * its results. Checks `signal` before each chunk.
 */
export async function* iterateBatches<TKey, TValue>(
  keys: Iterable<TKey>,
  load: (chunk: Array<TKey>) => Promise<Map<TKey, TValue | null>>,
  options: IterateBatchesOptions,
): AsyncGenerator<{ keys: Array<TKey>; results: Map<TKey, TValue | null> }> {
  const { batchSize, signal } = options
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive integer')
  }
  for (const chunkKeys of chunk([...new Set(keys)], batchSize)) {
    signal?.throwIfAborted()
    yield { keys: chunkKeys, results: await load(chunkKeys) }
  }
}
