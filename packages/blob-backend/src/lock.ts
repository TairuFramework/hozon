// A BlobLock serializes work per blob ID. Locks are non-reentrant: calling
// `withLock` for the same ID from inside `fn` deadlocks.
export type BlobLock = {
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>
}

// Thrown by lock implementations that give up waiting for a lock.
export class BlobLockTimeoutError extends Error {
  constructor(message = 'Timed out waiting for blob lock', options?: ErrorOptions) {
    super(message, options)
    this.name = 'BlobLockTimeoutError'
  }
}

// In-process lock: a keyed promise chain.
export function createMemoryBlobLock(): BlobLock {
  const tails = new Map<string, Promise<void>>()
  return {
    async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(id) ?? Promise.resolve()
      const run = previous.then(fn)
      const tail = run.then(
        () => {},
        () => {},
      )
      tails.set(id, tail)
      try {
        return await run
      } finally {
        if (tails.get(id) === tail) {
          tails.delete(id)
        }
      }
    },
  }
}
