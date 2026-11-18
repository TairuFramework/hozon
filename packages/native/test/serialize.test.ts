import { expect, test } from 'vitest'

import { serialize } from '../src/serialize.js'

test('serialize preserves bigint and blobs and converts JS values', () => {
  const blob = new Uint8Array([0, 255])
  expect(
    serialize([true, false, undefined, null, 9223372036854775807n, blob, new Date(0), { a: 1 }]),
  ).toEqual([1, 0, null, null, 9223372036854775807n, blob, '1970-01-01T00:00:00.000Z', '{"a":1}'])
  expect(() => serialize([Symbol('bad')])).toThrow('Unsupported')
})
