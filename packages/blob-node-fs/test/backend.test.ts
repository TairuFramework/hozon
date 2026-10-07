import { chmod, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobBackend } from '@hozon/blob-backend'
import { MemoryBlobBackend } from '@hozon/blob-backend'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { FSBlobBackend } from '../src/fs.js'

const BLOB = new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256))

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Array<Uint8Array> = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value != null) parts.push(value)
  }
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function writeBlob(
  backend: BlobBackend,
  stagingID: string,
  bytes: Uint8Array,
): Promise<void> {
  const ws = await backend.createStaging(stagingID)
  const writer = ws.getWriter()
  await writer.write(bytes)
  await writer.close()
}

const backends: Array<{
  name: string
  create(): Promise<{ backend: BlobBackend; cleanup(): Promise<void> }>
}> = [
  {
    name: 'MemoryBlobBackend',
    async create() {
      return { backend: new MemoryBlobBackend(), async cleanup() {} }
    },
  },
  {
    name: 'FSBlobBackend',
    async create() {
      const dir = await mkdtemp(join(tmpdir(), 'hozon-blob-'))
      return {
        backend: new FSBlobBackend(dir),
        async cleanup() {
          await rm(dir, { recursive: true, force: true })
        },
      }
    },
  },
]

describe.each(backends)('$name', ({ create }) => {
  let backend: BlobBackend
  let cleanup: () => Promise<void>
  const key = 'contentkey0001'

  beforeAll(async () => {
    const created = await create()
    backend = created.backend
    cleanup = created.cleanup
  })
  afterAll(async () => {
    await cleanup()
  })

  test('stage, commit, read back identical bytes', async () => {
    await writeBlob(backend, 'stg-1', BLOB)
    expect(await backend.has(key)).toBe(false)
    await backend.commit('stg-1', key)
    expect(await backend.has(key)).toBe(true)
    const read = await drain(await backend.createReadStream(key))
    expect(Array.from(read)).toEqual(Array.from(BLOB))
  })

  test('range read returns the inclusive slice', async () => {
    const read = await drain(await backend.createReadStream(key, { start: 10, end: 19 }))
    expect(Array.from(read)).toEqual(Array.from(BLOB.subarray(10, 20)))
  })

  test('commit is a no-op when the key already exists', async () => {
    await writeBlob(backend, 'stg-dup', BLOB)
    await backend.commit('stg-dup', key)
    const read = await drain(await backend.createReadStream(key))
    expect(Array.from(read)).toEqual(Array.from(BLOB))
  })

  test('abortStaging discards staged bytes', async () => {
    await writeBlob(backend, 'stg-abort', BLOB)
    await backend.abortStaging('stg-abort')
    await expect(backend.commit('stg-abort', 'contentkey0002')).rejects.toThrow()
  })

  test('delete removes committed bytes', async () => {
    await backend.delete(key)
    expect(await backend.has(key)).toBe(false)
  })

  test('writeChunk stages out-of-order ranges, commit assembles them', async () => {
    const chunkSize = 1024
    const chunk0 = BLOB.subarray(0, 1024)
    const chunk1 = BLOB.subarray(1024, 2048)
    const chunk2 = BLOB.subarray(2048, 4096) // final chunk spans the remaining bytes
    // Land them out of order at their absolute offsets.
    await backend.writeChunk('stg-chunks', 1 * chunkSize, chunk1)
    await backend.writeChunk('stg-chunks', 2 * chunkSize, chunk2)
    await backend.writeChunk('stg-chunks', 0 * chunkSize, chunk0)
    const chunkKey = 'contentkey0003'
    await backend.commit('stg-chunks', chunkKey)
    const read = await drain(await backend.createReadStream(chunkKey))
    expect(Array.from(read)).toEqual(Array.from(BLOB))
  })

  test('staging stream accepts reused buffers after each awaited write', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const writer = (await backend.createStaging('stg-reused-stream')).getWriter()
    await writer.write(bytes)
    bytes.fill(4)
    await writer.write(bytes)
    bytes.fill(9)
    await writer.close()
    await backend.commit('stg-reused-stream', 'reused-stream')
    expect(Array.from(await drain(await backend.createReadStream('reused-stream')))).toEqual([
      1, 2, 3, 4, 4, 4,
    ])
  })

  test('chunk writes accept reused buffers', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await backend.writeChunk('stg-reused-chunk', 0, bytes)
    bytes.fill(4)
    await backend.writeChunk('stg-reused-chunk', 3, bytes)
    bytes.fill(9)
    await backend.commit('stg-reused-chunk', 'reused-chunk')
    expect(Array.from(await drain(await backend.createReadStream('reused-chunk')))).toEqual([
      1, 2, 3, 4, 4, 4,
    ])
  })

  test('mutating read bytes does not change committed content', async () => {
    await writeBlob(backend, 'stg-read-copy', BLOB)
    await backend.commit('stg-read-copy', 'read-copy')
    const reader = (await backend.createReadStream('read-copy')).getReader()
    const { value } = await reader.read()
    expect(value).toBeDefined()
    value?.fill(0)
    await reader.cancel()
    expect(Array.from(await drain(await backend.createReadStream('read-copy')))).toEqual(
      Array.from(BLOB),
    )
  })

  test('getURL returns a locator when supported, or null', async () => {
    await writeBlob(backend, 'stg-url', BLOB)
    await backend.commit('stg-url', 'url-key')
    const url = await backend.getURL('url-key')
    if (url != null) {
      expect(Array.from(await readFile(new URL(url)))).toEqual(Array.from(BLOB))
    }
    await backend.delete('url-key')
    expect(await backend.getURL('url-key')).toBeNull()
  })
})

test('staging writer.closed rejects opening failures without another operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hozon-blob-'))
  const backend = new FSBlobBackend(root)
  try {
    await writeBlob(backend, 'initial-staging', BLOB)
    await rm(join(root, 'staging'), { recursive: true })
    const writer = (await backend.createStaging('missing-directory')).getWriter()
    await expect(writer.closed).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe('FSBlobBackend key validation', () => {
  let root: string
  let backend: FSBlobBackend

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hozon-blob-'))
    backend = new FSBlobBackend(root)
    await writeBlob(backend, 'existing-staging', BLOB)
    await backend.commit('existing-staging', 'existing-key')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'C:x', 'a\0b', 'a..b'])(
    'rejects unsafe key %j',
    async (value) => {
      const error = new Error(`Invalid blob key: ${JSON.stringify(value)}`)
      await expect(backend.commit('valid-staging', value)).rejects.toThrow(error)
      await expect(backend.createReadStream(value)).rejects.toThrow(error)
      await expect(backend.has(value)).rejects.toThrow(error)
      await expect(backend.delete(value)).rejects.toThrow(error)
      await expect(backend.getURL(value)).rejects.toThrow(error)
      await expect(backend.createStaging(value)).rejects.toThrow(error)
      await expect(backend.writeChunk(value, 0, BLOB)).rejects.toThrow(error)
      await expect(backend.commit(value, 'valid-key')).rejects.toThrow(error)
      await expect(backend.commit(value, 'existing-key')).rejects.toThrow(error)
      await expect(backend.abortStaging(value)).rejects.toThrow(error)
    },
  )

  test('content stays inside root', async () => {
    await writeBlob(backend, 'inside-root', BLOB)
    await backend.commit('inside-root', 'abc')
    expect(Array.from(await readFile(join(root, 'content', 'abc')))).toEqual(Array.from(BLOB))
    expect(await backend.getURL('abc')).toBe(new URL(`file://${join(root, 'content', 'abc')}`).href)
  })

  test('missing content returns false and a null URL', async () => {
    expect(await backend.has('missing')).toBe(false)
    expect(await backend.getURL('missing')).toBeNull()
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'permission failures propagate from has and getURL',
    async () => {
      const contentDir = join(root, 'content')
      await chmod(contentDir, 0)
      try {
        await expect(backend.has('existing-key')).rejects.toMatchObject({ code: 'EACCES' })
        await expect(backend.getURL('existing-key')).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(contentDir, 0o700)
      }
    },
  )

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'symlink loop failures propagate from has and getURL',
    async () => {
      await symlink('loop', join(root, 'content', 'loop'))
      await expect(backend.has('loop')).rejects.toMatchObject({ code: 'ELOOP' })
      await expect(backend.getURL('loop')).rejects.toMatchObject({ code: 'ELOOP' })
    },
  )
})
