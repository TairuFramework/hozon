import type { BlobIDCodec, HashResult } from './types.js'

/**
 * Pass-through transform computing the whole-content digest and a digest per
 * `chunkSize` chunk. Memory is bounded to the incoming piece.
 */
export function hashStream(
  codec: BlobIDCodec,
  chunkSize: number,
): { transform: TransformStream<Uint8Array, Uint8Array>; result: Promise<HashResult> } {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`Invalid chunk size: ${chunkSize}`)
  }
  let resolve!: (value: HashResult) => void
  let reject!: (reason: unknown) => void
  const result = new Promise<HashResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Callers may never await result when they abandon the stream.
  result.catch(() => {})

  const whole = codec.createHasher()
  const chunks: Array<Uint8Array> = []
  let current = codec.createHasher()
  let currentLength = 0
  let contentLength = 0

  // `cancel` is in the Streams spec but missing from the bundled DOM typings.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(reason?: unknown): void } = {
    transform(piece, controller) {
      try {
        whole.update(piece)
        contentLength += piece.length
        let offset = 0
        while (offset < piece.length) {
          const take = Math.min(chunkSize - currentLength, piece.length - offset)
          current.update(piece.subarray(offset, offset + take))
          currentLength += take
          offset += take
          if (currentLength === chunkSize) {
            chunks.push(current.digest())
            current = codec.createHasher()
            currentLength = 0
          }
        }
        controller.enqueue(piece)
      } catch (error) {
        reject(error)
        throw error
      }
    },
    flush() {
      try {
        if (currentLength > 0) {
          chunks.push(current.digest())
        }
        resolve({ digest: whole.digest(), contentLength, chunks })
      } catch (error) {
        reject(error)
        throw error
      }
    },
    cancel(reason) {
      reject(reason ?? new Error('Hash stream cancelled'))
    },
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>(transformer)

  return { transform, result }
}
