import { describe, expect, test } from 'vitest'

import { serialize } from '../src/serialize.js'

describe('serialize', () => {
  test('binds booleans as 1/0', () => {
    expect(serialize([true, false])).toEqual([1, 0])
  })

  test('binds Dates as ISO strings', () => {
    const date = new Date('2026-10-06T12:34:56.789Z')
    expect(serialize([date])).toEqual(['2026-10-06T12:34:56.789Z'])
  })

  test('passes Uint8Array through unchanged', () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    const [bound] = serialize([bytes])
    expect(bound).toBe(bytes)
  })

  test('passes strings and numbers through and binds nullish values as null', () => {
    expect(serialize(['雪 🦊', 42, 1.5, null, undefined])).toEqual(['雪 🦊', 42, 1.5, null, null])
  })

  test('binds other objects as JSON', () => {
    expect(serialize([{ nested: [1, true] }])).toEqual(['{"nested":[1,true]}'])
  })

  test('rejects unsupported types', () => {
    expect(() => serialize([Symbol('x')])).toThrow('Unsupported bind value type: symbol')
  })
})
