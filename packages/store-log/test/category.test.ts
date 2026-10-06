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
test('range matches only whole segment prefixes', () => {
  const { gte, lt } = categoryRange(['a'])
  for (const segments of [['a'], ['a', 'b'], ['a', '😀']]) {
    const encoded = encodeCategory(segments)
    expect(encoded >= gte && encoded < lt).toBe(true)
  }
  for (const segments of [['ab'], ['a.b'], []]) {
    const encoded = encodeCategory(segments)
    expect(encoded >= gte && encoded < lt).toBe(false)
  }
})
