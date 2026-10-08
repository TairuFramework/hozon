import type { BlobBackend, BlobRange } from './backend.js'

// In-memory BlobBackend for tests and ephemeral use. Staging and committed
// bytes live in Maps; nothing is persisted.
type StagingSegment = { offset: number; bytes: Uint8Array }
type StagingArea = { segments: Array<StagingSegment>; modifiedAt: Date }

export class MemoryBlobBackend implements BlobBackend {
  // Staging holds offset-addressed segments so sequential writes (createStaging)
  // and out-of-order chunk writes (writeChunk) share one assembly path.
  #staging = new Map<string, StagingArea>()
  #committed = new Map<string, Uint8Array>()

  #area(stagingID: string): StagingArea {
    let area = this.#staging.get(stagingID)
    if (area == null) {
      area = { segments: [], modifiedAt: new Date() }
      this.#staging.set(stagingID, area)
    }
    return area
  }

  async createStaging(stagingID: string): Promise<WritableStream<Uint8Array>> {
    const area: StagingArea = { segments: [], modifiedAt: new Date() }
    this.#staging.set(stagingID, area)
    let offset = 0
    return new WritableStream<Uint8Array>({
      write(chunk) {
        area.segments.push({ offset, bytes: new Uint8Array(chunk) })
        area.modifiedAt = new Date()
        offset += chunk.length
      },
    })
  }

  async writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void> {
    const area = this.#area(stagingID)
    area.segments.push({ offset, bytes: new Uint8Array(bytes) })
    area.modifiedAt = new Date()
  }

  async createStagingReadStream(
    stagingID: string,
    range?: BlobRange,
  ): Promise<ReadableStream<Uint8Array>> {
    const area = this.#staging.get(stagingID)
    if (area == null) {
      throw new Error(`No staging area for ${stagingID}`)
    }
    return singleChunkStream(assemble(area.segments), range)
  }

  async *listStaging(): AsyncIterable<{ stagingID: string; modifiedAt: Date }> {
    for (const [stagingID, area] of [...this.#staging]) {
      yield { stagingID, modifiedAt: area.modifiedAt }
    }
  }

  async commit(stagingID: string, key: string): Promise<void> {
    if (this.#committed.has(key)) {
      this.#staging.delete(stagingID)
      return
    }
    const area = this.#staging.get(stagingID)
    if (area == null) {
      throw new Error(`No staging area for ${stagingID}`)
    }
    this.#committed.set(key, assemble(area.segments))
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
    return singleChunkStream(bytes, range)
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

function singleChunkStream(bytes: Uint8Array, range?: BlobRange): ReadableStream<Uint8Array> {
  const slice = range == null ? bytes.slice() : bytes.slice(range.start, range.end + 1)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(slice)
      controller.close()
    },
  })
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
