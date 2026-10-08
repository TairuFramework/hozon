import { describe, expect, test } from 'vitest'

import { blake3Codec } from '../src/blake3.js'
import { hashStream } from '../src/hash-stream.js'

function digestOf(content: Uint8Array): Uint8Array {
  const hasher = blake3Codec.createHasher()
  hasher.update(content)
  return hasher.digest()
}

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 5) % 256)
}

function sourceOf(pieces: Array<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece)
      controller.close()
    },
  })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Array<number> = []
  for await (const piece of stream) parts.push(...piece)
  return Uint8Array.from(parts)
}

function split(content: Uint8Array, sizes: Array<number>): Array<Uint8Array> {
  const pieces: Array<Uint8Array> = []
  let offset = 0
  for (const size of sizes) {
    pieces.push(content.subarray(offset, offset + size))
    offset += size
  }
  return pieces
}

describe('hashStream', () => {
  test('hashes empty input', async () => {
    const { transform, result } = hashStream(blake3Codec, 4)
    const output = await drain(sourceOf([]).pipeThrough(transform))
    expect(output).toEqual(new Uint8Array())
    expect(await result).toEqual({
      digest: digestOf(new Uint8Array()),
      contentLength: 0,
      chunks: [],
    })
  })

  test('hashes an exact multiple of chunkSize', async () => {
    const content = bytes(8)
    const { transform, result } = hashStream(blake3Codec, 4)
    await drain(sourceOf([content]).pipeThrough(transform))
    const hashed = await result
    expect(hashed.contentLength).toBe(8)
    expect(hashed.digest).toEqual(digestOf(content))
    expect(hashed.chunks).toEqual([digestOf(content.subarray(0, 4)), digestOf(content.subarray(4))])
  })

  test('splits pieces at chunk boundaries', async () => {
    const content = bytes(10)
    const { transform, result } = hashStream(blake3Codec, 4)
    await drain(sourceOf(split(content, [3, 5, 2])).pipeThrough(transform))
    const hashed = await result
    expect(hashed.contentLength).toBe(10)
    expect(hashed.digest).toEqual(digestOf(content))
    expect(hashed.chunks).toEqual([
      digestOf(content.subarray(0, 4)),
      digestOf(content.subarray(4, 8)),
      digestOf(content.subarray(8)),
    ])
  })

  test('passes bytes through unchanged', async () => {
    const content = bytes(10)
    const { transform } = hashStream(blake3Codec, 4)
    expect(await drain(sourceOf(split(content, [3, 5, 2])).pipeThrough(transform))).toEqual(content)
  })

  test('rejects result when the source errors', async () => {
    const { transform, result } = hashStream(blake3Codec, 4)
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(3))
        controller.error(new Error('boom'))
      },
    })
    const settled = result.then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await drain(failing.pipeThrough(transform)).catch(() => {})
    expect(await settled).toBe('boom')
  })

  test('rejects result when the output is cancelled', async () => {
    const { transform, result } = hashStream(blake3Codec, 4)
    const settled = result.then(
      () => 'resolved',
      () => 'rejected',
    )
    const reader = sourceOf([bytes(3)])
      .pipeThrough(transform)
      .getReader()
    await reader.cancel(new Error('stop'))
    expect(await settled).toBe('rejected')
  })
})
