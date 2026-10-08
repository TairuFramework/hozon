import { describe, expect, test } from 'vitest'

import { decodeVarint, encodeVarint } from '../src/varint.js'

describe('varint', () => {
  test.each([0, 1, 127, 128, 16383, 16384, 2 ** 32, Number.MAX_SAFE_INTEGER])(
    'round trips %d',
    (n) => {
      const bytes = encodeVarint(n)
      expect(decodeVarint(bytes)).toEqual({ value: n, length: bytes.length })
    },
  )

  test('encodes 300 as LEB128', () => {
    expect(Array.from(encodeVarint(300))).toEqual([0xac, 0x02])
  })

  test('decodes at an offset', () => {
    expect(decodeVarint(new Uint8Array([9, 0xac, 0x02, 7]), 1)).toEqual({ value: 300, length: 2 })
  })

  test('throws on truncated input', () => {
    expect(() => decodeVarint(new Uint8Array([0x80]))).toThrow()
    expect(() => decodeVarint(new Uint8Array([]))).toThrow()
  })

  test('throws on invalid input', () => {
    expect(() => encodeVarint(-1)).toThrow()
    expect(() => encodeVarint(1.5)).toThrow()
    expect(() => encodeVarint(Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })
})
