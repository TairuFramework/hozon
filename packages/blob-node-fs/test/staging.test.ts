import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { FSBlobBackend } from '../src/fs.js'

let root: string
let backend: FSBlobBackend

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hozon-blob-staging-'))
  backend = new FSBlobBackend(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Array<number>> {
  const reader = stream.getReader()
  const bytes: Array<number> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) return bytes
    bytes.push(...value)
  }
}

async function listAll(): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  for await (const entry of backend.listStaging()) {
    out.set(entry.stagingID, entry.modifiedAt)
  }
  return out
}

test('createStagingReadStream reads sequential and out-of-order staging, with and without range', async () => {
  const writer = (await backend.createStaging('s1')).getWriter()
  await writer.write(new Uint8Array([0, 1, 2]))
  await writer.write(new Uint8Array([3, 4]))
  await writer.close()
  expect(await readBytes(await backend.createStagingReadStream('s1'))).toEqual([0, 1, 2, 3, 4])
  expect(
    await readBytes(await backend.createStagingReadStream('s1', { start: 1, end: 3 })),
  ).toEqual([1, 2, 3])
  await backend.writeChunk('s2', 4, new Uint8Array([4, 5, 6, 7]))
  await backend.writeChunk('s2', 0, new Uint8Array([0, 1, 2, 3]))
  expect(await readBytes(await backend.createStagingReadStream('s2'))).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ])
  expect(
    await readBytes(await backend.createStagingReadStream('s2', { start: 2, end: 5 })),
  ).toEqual([2, 3, 4, 5])
})

test('createStagingReadStream rejects for an unknown staging ID', async () => {
  await expect(backend.createStagingReadStream('missing')).rejects.toThrow()
})

test('createStagingReadStream rejects unsafe staging IDs', async () => {
  await expect(backend.createStagingReadStream('../x')).rejects.toThrow('Invalid blob key')
})

test('listStaging yields nothing when no staging directory exists', async () => {
  expect((await listAll()).size).toBe(0)
})

test('listStaging yields live staging areas with file mtime', async () => {
  await backend.writeChunk('s1', 0, new Uint8Array([1]))
  await backend.writeChunk('s2', 0, new Uint8Array([2]))
  const at = new Date('2026-01-01T00:00:10Z')
  await utimes(join(root, 'staging', 's1'), at, at)
  const listed = await listAll()
  expect([...listed.keys()].sort()).toEqual(['s1', 's2'])
  expect(listed.get('s1')?.toISOString()).toBe('2026-01-01T00:00:10.000Z')
})

test('listStaging works with an existing empty staging directory', async () => {
  await mkdir(join(root, 'staging'), { recursive: true })
  expect((await listAll()).size).toBe(0)
})

test('committed and aborted staging IDs are no longer listed', async () => {
  await backend.writeChunk('s1', 0, new Uint8Array([1]))
  await backend.writeChunk('s2', 0, new Uint8Array([2]))
  await backend.commit('s1', 'k')
  await backend.abortStaging('s2')
  expect((await listAll()).size).toBe(0)
  await expect(backend.createStagingReadStream('s1')).rejects.toThrow()
})
