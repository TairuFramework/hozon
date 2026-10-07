import type { BlobBackend, BlobRange } from './backend.js'

// In-memory BlobBackend for tests and ephemeral use. Staging and committed
// bytes live in Maps; nothing is persisted.
type StagingSegment = { offset: number; bytes: Uint8Array }

export class MemoryBlobBackend implements BlobBackend {
  // Staging holds offset-addressed segments so sequential writes (createStaging)
  // and out-of-order chunk writes (writeChunk) share one assembly path.
  #staging = new Map<string, Array<StagingSegment>>()
  #committed = new Map<string, Uint8Array>()

  #segments(stagingID: string): Array<StagingSegment> {
    let segments = this.#staging.get(stagingID)
    if (segments == null) {
      segments = []
      this.#staging.set(stagingID, segments)
    }
    return segments
  }

  async createStaging(stagingID: string): Promise<WritableStream<Uint8Array>> {
    const segments = this.#segments(stagingID)
    let offset = 0
    return new WritableStream<Uint8Array>({
      write(chunk) {
        segments.push({ offset, bytes: new Uint8Array(chunk) })
        offset += chunk.length
      },
    })
  }

  async writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void> {
    this.#segments(stagingID).push({ offset, bytes: new Uint8Array(bytes) })
  }

  async commit(stagingID: string, key: string): Promise<void> {
    if (this.#committed.has(key)) {
      this.#staging.delete(stagingID)
      return
    }
    const segments = this.#staging.get(stagingID)
    if (segments == null) {
      throw new Error(`No staging area for ${stagingID}`)
    }
    this.#committed.set(key, assemble(segments))
    this.#staging.delete(stagingID)
  }

  async abortStaging(stagingID: string): Promise<void> {
    this.#staging.delete(stagingID)
  }

  async createReadStream(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.#committed.get(key)
    if (bytes == null) {
      throw new Error(`No blob for key ${key}`)
    }
    const slice = range == null ? bytes.slice() : bytes.slice(range.start, range.end + 1)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice)
        controller.close()
      },
    })
  }

  async has(key: string): Promise<boolean> {
    return this.#committed.has(key)
  }

  async delete(key: string): Promise<void> {
    this.#committed.delete(key)
  }

  // In-memory bytes have no addressable location.
  async getURL(_key: string): Promise<string | null> {
    return null
  }
}

function assemble(segments: Array<StagingSegment>): Uint8Array {
  let length = 0
  for (const segment of segments) {
    length = Math.max(length, segment.offset + segment.bytes.length)
  }
  const out = new Uint8Array(length)
  for (const segment of segments) {
    out.set(segment.bytes, segment.offset)
  }
  return out
}
