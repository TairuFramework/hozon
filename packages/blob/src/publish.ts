import type { BlobBackend } from '@hozon/blob-backend'

// A failed database commit can consume staging. Keep its original error if nothing remains.
export async function commitStaging(
  backend: BlobBackend,
  stagingID: string,
  blobID: string,
  originalError?: unknown,
): Promise<void> {
  try {
    await backend.commit(stagingID, blobID)
  } catch (error) {
    if (originalError !== undefined && !(await backend.has(blobID))) {
      let stream: ReadableStream<Uint8Array>
      try {
        stream = await backend.createStagingReadStream(stagingID)
      } catch {
        // biome-ignore lint/style/useErrorCause: The retry contract preserves the first database error.
        throw originalError
      }
      await stream.cancel()
    }
    throw error
  }
}
