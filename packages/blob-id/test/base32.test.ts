import { describe, expect, test } from 'vitest'

import { base32Decode, base32Encode } from '../src/base32.js'

const text = new TextEncoder()

describe('base32', () => {
  test.each([
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foobar', 'mzxw6ytboi'],
  ])('encodes and decodes %j', (input, expected) => {
    expect(base32Encode(text.encode(input))).toBe(expected)
    expect(base32Decode(expected)).toEqual(text.encode(input))
  })

  test('rejects characters outside [a-z2-7]', () => {
    for (const bad of ['MY', 'm1', 'm=', 'm8', 'm-', 'm y']) {
      expect(() => base32Decode(bad)).toThrow()
    }
  })

  test('rejects non-zero trailing bits', () => {
    expect(() => base32Decode('mz')).toThrow()
  })

  test('rejects impossible lengths', () => {
    expect(() => base32Decode('m')).toThrow()
  })
})
