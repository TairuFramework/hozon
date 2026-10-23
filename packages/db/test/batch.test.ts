import { describe, expect, test } from 'vitest'

import { assertBatchSize, iterateBatches } from '../src/batch.js'
import { BatchLimitError } from '../src/errors.js'
import { chunk, IN_LIST_CHUNK } from '../src/index.js'

describe('chunk', () => {
  test('chunk keeps duplicates by default', () => {
    expect(chunk([1, 2, 1, 3], 2)).toEqual([
      [1, 2],
      [1, 3],
    ])
    expect(chunk([1, 2, 1, 3], 2, { unique: false })).toEqual([
      [1, 2],
      [1, 3],
    ])
  })

  test('chunk unique dedupes across chunk boundaries', () => {
    expect(chunk([1, 2, 1, 3], 2, { unique: true })).toEqual([[1, 2], [3]])
  })

  test('accepts iterables with and without deduplication', () => {
    function* items() {
      yield 1
      yield 2
      yield 1
      yield 3
    }
    expect(chunk(items(), 2)).toEqual([
      [1, 2],
      [1, 3],
    ])
    expect(chunk(items(), 2, { unique: true })).toEqual([[1, 2], [3]])
    expect(chunk(new Set<number>(), 2, { unique: true })).toEqual([])
  })

  test('defaults to the exported IN list chunk size', () => {
    expect(IN_LIST_CHUNK).toBe(500)
    expect(
      chunk(Array.from({ length: 501 }, (_, index) => index)).map((part) => part.length),
    ).toEqual([500, 1])
  })

  test('chunk rejects non-positive size', () => {
    for (const size of [0, -1]) {
      expect(() => chunk([1], size)).toThrow(RangeError)
      expect(() => chunk([1], size, { unique: true })).toThrow(RangeError)
    }
  })
})

describe('assertBatchSize', () => {
  test('accepts sizes within the limit', () => {
    expect(() => assertBatchSize(500, 500)).not.toThrow()
    expect(() => assertBatchSize(10, 500, 10)).not.toThrow()
  })

  test('throws BatchLimitError above the effective limit', () => {
    expect(() => assertBatchSize(501, 500)).toThrow(BatchLimitError)
    expect(() => assertBatchSize(11, 500, 10)).toThrow('Batch of 11 keys exceeds limit 10')
  })

  test('rejects an invalid batchLimit', () => {
    for (const limit of [0, -1, 1.5, 501]) {
      expect(() => assertBatchSize(1, 500, limit)).toThrow(RangeError)
    }
  })
})

describe('iterateBatches', () => {
  test('dedupes, chunks in order and calls load once per chunk', async () => {
    const calls: Array<Array<string>> = []
    const load = async (chunk: Array<string>) => {
      calls.push(chunk)
      return new Map<string, string | null>(chunk.map((k) => [k, k.toUpperCase()]))
    }
    const seen = []
    for await (const batch of iterateBatches(['a', 'b', 'a', 'c', 'd', 'e'], load, {
      batchSize: 2,
    })) {
      seen.push(batch)
    }
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual({
      keys: ['a', 'b'],
      results: new Map([
        ['a', 'A'],
        ['b', 'B'],
      ]),
    })
  })

  test('yields nothing for empty input', async () => {
    let calls = 0
    const load = async () => {
      calls++
      return new Map<string, string | null>()
    }
    const seen = []
    for await (const batch of iterateBatches<string, string>([], load, { batchSize: 2 })) {
      seen.push(batch)
    }
    expect(seen).toEqual([])
    expect(calls).toBe(0)
  })

  test('stops and throws signal.reason when aborted between chunks', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    let calls = 0
    const load = async (chunk: Array<string>) => {
      calls++
      return new Map<string, string | null>(chunk.map((k) => [k, k]))
    }
    const iterator = iterateBatches(['a', 'b', 'c'], load, {
      batchSize: 1,
      signal: controller.signal,
    })
    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort(reason)
    await expect(iterator.next()).rejects.toBe(reason)
    expect(calls).toBe(1)
  })

  test('rejects an invalid batchSize with RangeError', async () => {
    const load = async () => new Map<string, string | null>()
    for (const batchSize of [0, 1.5]) {
      await expect(iterateBatches(['a'], load, { batchSize }).next()).rejects.toThrow(RangeError)
    }
  })
})
