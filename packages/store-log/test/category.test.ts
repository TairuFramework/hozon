import { expect, test } from 'vitest'

import { categoryRange, encodeCategory } from '../src/index.js'

test('encodes whole segments injectively', () => {
  expect(encodeCategory(['a', 'b'])).toBe('a\u001fb\u001f')
  expect(encodeCategory(['a.b'])).not.toBe(encodeCategory(['a', 'b']))
  expect(encodeCategory([])).toBe('')
  expect(encodeCategory([''])).toBe('\u001f')
})
test('rejects separator in a segment', () => {
  expect(() => encodeCategory(['a\u001fb'])).toThrow(TypeError)
  expect(() => categoryRange(['a\u001fb'])).toThrow(TypeError)
})
test('range ends at the successor of the final separator', () => {
  expect(categoryRange(['a'])).toEqual({ gte: 'a\u001f', lt: 'a ' })
  expect(categoryRange(['a', 'b'])).toEqual({ gte: 'a\u001fb\u001f', lt: 'a\u001fb ' })
})
