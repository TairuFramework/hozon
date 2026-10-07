import { constants, createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { BlobBackend, BlobRange } from '@hozon/blob-backend'

// Filesystem BlobBackend. Staged uploads land under `<root>/staging`, committed
// blobs under `<root>/content/<key>`. Commit publishes a hard link within the same
// filesystem. Names must be nonempty, not `.`, and contain no `..`,
// path separators, colons, or NUL bytes.
function assertSafeName(value: string): void {
  if (value === '' || value === '.' || value.includes('..') || /[/\\:\0]/.test(value)) {
    throw new Error(`Invalid blob key: ${JSON.stringify(value)}`)
  }
}

export class FSBlobBackend implements BlobBackend {
  #stagingDir: string
  #contentDir: string
  #ready: Promise<void> | null = null

  constructor(root: string) {
    this.#stagingDir = join(root, 'staging')
    this.#contentDir = join(root, 'content')
  }

  #ensureDirs(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#stagingDir, { recursive: true })
      await mkdir(this.#contentDir, { recursive: true })
    })()
    return this.#ready
  }

  #stagingPath(stagingID: string): string {
    assertSafeName(stagingID)
    return join(this.#stagingDir, stagingID)
  }

  #contentPath(key: string): string {
    assertSafeName(key)
    return join(this.#contentDir, key)
  }

  async createStaging(stagingID: string): Promise<WritableStream<Uint8Array>> {
    await this.#ensureDirs()
    const nodeStream = createWriteStream(this.#stagingPath(stagingID))
    const writer = (Writable.toWeb(nodeStream) as WritableStream<Uint8Array>).getWriter()
    return new WritableStream<Uint8Array>({
      start(controller) {
        void writer.closed.catch((error) => controller.error(error))
      },
      write(chunk) {
        // Node may retain the chunk after the Web write resolves.
        return writer.write(new Uint8Array(chunk))
      },
      close() {
        return writer.close()
      },
      abort(reason) {
        return writer.abort(reason)
      },
    })
  }

  async writeChunk(stagingID: string, offset: number, bytes: Uint8Array): Promise<void> {
    await this.#ensureDirs()
    // O_RDWR | O_CREAT: create-if-absent, no truncate — positioned writes into a
    // possibly-sparse file as out-of-order ranges arrive.
    const handle = await open(this.#stagingPath(stagingID), constants.O_RDWR | constants.O_CREAT)
    try {
      let written = 0
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.length - written,
          offset + written,
        )
        if (bytesWritten === 0) throw new Error(`No progress writing staging area ${stagingID}`)
        written += bytesWritten
      }
    } finally {
      await handle.close()
    }
  }

  async commit(stagingID: string, key: string): Promise<void> {
    await this.#ensureDirs()
    const stagingPath = this.#stagingPath(stagingID)
    const contentPath = this.#contentPath(key)
    try {
      // link refuses to replace existing content on both POSIX and Windows.
      await link(stagingPath, contentPath)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error)) throw error
      // Another commit may have published and removed this staging file already.
      if (error.code !== 'EEXIST' && !(error.code === 'ENOENT' && (await this.has(key))))
        throw error
    }
    await rm(stagingPath, { force: true })
  }

  async abortStaging(stagingID: string): Promise<void> {
    await rm(this.#stagingPath(stagingID), { force: true })
  }

  async createReadStream(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array>> {
    // createReadStream's `end` is inclusive, matching BlobRange.
    const options = range == null ? undefined : { start: range.start, end: range.end }
    const nodeStream = createReadStream(this.#contentPath(key), options)
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  }

  async has(key: string): Promise<boolean> {
    const path = this.#contentPath(key)
    try {
      await stat(path)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#contentPath(key), { force: true })
  }

  async getURL(key: string): Promise<string | null> {
    if (!(await this.has(key))) return null
    return pathToFileURL(this.#contentPath(key)).href
  }
}
