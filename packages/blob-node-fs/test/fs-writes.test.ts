import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import { FSBlobBackend } from '../src/fs.js'

type PositionedWrite = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>

test('positioned writes retry short writes with advancing buffer and file offsets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hozon-short-write-'))
  const handle = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { write: PositionedWrite }
  const write: PositionedWrite = handle.write
  const spy = vi.spyOn(prototype, 'write').mockImplementation(function (
    this: typeof handle,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) {
    return write.call(this, buffer, offset, Math.min(length, 2), position)
  })
  try {
    const backend = new FSBlobBackend(root)
    await backend.writeChunk('short', 3, new Uint8Array([1, 2, 3, 4, 5]))
    await backend.commit('short', 'short-key')
    expect(Array.from(await readFile(join(root, 'content', 'short-key')))).toEqual([
      0, 0, 0, 1, 2, 3, 4, 5,
    ])
  } finally {
    spy.mockRestore()
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('positioned writes reject zero progress and close the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hozon-zero-write-'))
  const handle = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { write: PositionedWrite }
  const spy = vi
    .spyOn(prototype, 'write')
    .mockImplementation(async (buffer) => ({ bytesWritten: 0, buffer }))
  try {
    const backend = new FSBlobBackend(root)
    await expect(backend.writeChunk('zero', 0, new Uint8Array([1]))).rejects.toThrow(
      'No progress writing staging area zero',
    )
    await backend.abortStaging('zero')
  } finally {
    spy.mockRestore()
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})
