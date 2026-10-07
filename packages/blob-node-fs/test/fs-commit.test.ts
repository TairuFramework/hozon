import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import { FSBlobBackend } from '../src/fs.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, link: vi.fn(original.link), rename: vi.fn(original.rename) }
})

test('competing uploads publish atomically without replacing the first committed bytes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hozon-commit-race-'))
  const original = await vi.importActual<typeof fs>('node:fs/promises')
  let calls = 0
  let bothReady!: () => void
  const ready = new Promise<void>((resolve) => {
    bothReady = resolve
  })
  let releaseSecond!: () => void
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  // Hold both at publication so any earlier existence checks have already completed.
  const gate = async () => {
    const call = ++calls
    if (call === 2) bothReady()
    await ready
    if (call === 2) await second
  }
  vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
    await gate()
    return original.rename(source, destination)
  })
  vi.mocked(fs.link).mockImplementation(async (source, destination) => {
    await gate()
    return original.link(source, destination)
  })
  try {
    const backend = new FSBlobBackend(root)
    await backend.writeChunk('first', 0, new Uint8Array([1, 2, 3]))
    await backend.writeChunk('second', 0, new Uint8Array([9]))
    const first = backend.commit('first', 'winner')
    const competing = backend.commit('second', 'winner')
    await first
    expect(Array.from(await fs.readFile(join(root, 'content', 'winner')))).toEqual([1, 2, 3])
    releaseSecond()
    await competing
    expect(Array.from(await fs.readFile(join(root, 'content', 'winner')))).toEqual([1, 2, 3])
    await expect(fs.stat(join(root, 'staging', 'first'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(join(root, 'staging', 'second'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    releaseSecond()
    vi.mocked(fs.link).mockReset().mockImplementation(original.link)
    vi.mocked(fs.rename).mockReset().mockImplementation(original.rename)
    await fs.rm(root, { recursive: true, force: true })
  }
})
