import type { StoreProvider } from '@hozon/db'
import { withBlobLocks } from '@hozon/store-blob'

export async function retryTransaction<R>(
  provider: StoreProvider,
  fn: (originalError?: unknown) => Promise<R>,
): Promise<R> {
  let originalError: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(originalError)
    } catch (error) {
      if (provider.isTransactionBound || attempt >= 2 || !isDeadlock(error)) throw error
      originalError ??= error
      await new Promise<void>((resolve) =>
        setTimeout(resolve, (attempt + 1) * 10 + Math.random() * 10),
      )
    }
  }
}

export async function lockBlobs<R>(
  provider: StoreProvider,
  ids: Array<string>,
  fn: (tx: StoreProvider, originalError?: unknown) => Promise<R>,
): Promise<R> {
  return await retryTransaction(provider, (originalError) => {
    return withBlobLocks(provider, ids, (tx) => fn(tx, originalError))
  })
}

function isDeadlock(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '40P01'
}
