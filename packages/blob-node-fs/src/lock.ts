import { join } from 'node:path'
import { type BlobLock, BlobLockTimeoutError } from '@hozon/blob-backend'
import { TimeoutInterruption, withFileLock } from '@sozai/lock'

import { assertSafeName } from './fs.js'

export type FileBlobLockOptions = {
  /** Milliseconds to wait for the lock before rejecting with BlobLockTimeoutError. */
  acquireTimeoutMs?: number
}

// Cross-process lock: one `<directory>/<id>.lock` file per blob ID.
export function createFileBlobLock(directory: string, options: FileBlobLockOptions = {}): BlobLock {
  return {
    async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
      assertSafeName(id)
      // Only acquisition can time out; errors thrown by fn pass through untouched.
      let acquired = false
      try {
        return await withFileLock(
          join(directory, `${id}.lock`),
          () => {
            acquired = true
            return fn()
          },
          options.acquireTimeoutMs == null ? undefined : { timeout: options.acquireTimeoutMs },
        )
      } catch (error) {
        if (!acquired && error instanceof TimeoutInterruption) {
          throw new BlobLockTimeoutError(`Timed out waiting for blob lock ${id}`, { cause: error })
        }
        throw error
      }
    },
  }
}
