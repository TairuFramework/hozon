import { concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { fromB32, toB32 } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { blake3Codec } from '../src/blake3.js'
import { checkCodecConformance } from '../src/conformance.js'
import { InvalidBlobIDError } from '../src/errors.js'
import type { BlobIDCodec, BlobIDInfo } from '../src/types.js'
import { encodeVarint } from '../src/varint.js'

const BLAKE3_CODE = 0x1e

const EMPTY_HEX = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'

function digestOf(content: Uint8Array): Uint8Array {
  const hasher = blake3Codec.createHasher()
  hasher.update(content)
  return hasher.digest()
}

const samples = [0, 1, 5, 300].map((contentLength) => ({
  digest: digestOf(new Uint8Array(contentLength).fill(7)),
  contentLength,
}))

function sample(index: number): BlobIDInfo {
  const info = samples[index]
  if (info == null) throw new Error('missing sample')
  return info
}

describe('blake3Codec', () => {
  test('has 32-byte digests', () => {
    expect(blake3Codec.digestLength).toBe(32)
  })

  test('writes the multicodec blake3 code', () => {
    expect(blake3Codec.code).toBe(BLAKE3_CODE)
  })

  test.each([0, 127, 128, 2 ** 40])(
    'lays out code, length and digest for %i bytes',
    (contentLength) => {
      const digest = sample(3).digest
      const bytes = fromB32(blake3Codec.encode({ digest, contentLength }))
      expect(bytes).toEqual(
        concatBytes(encodeVarint(BLAKE3_CODE), encodeVarint(contentLength), digest),
      )
      expect(blake3Codec.decode(blake3Codec.encode({ digest, contentLength }))).toEqual({
        digest,
        contentLength,
      })
    },
  )

  test('rejects a different codec code', () => {
    const digest = sample(3).digest
    for (const code of [0x00, 0x12, 0x1f]) {
      const id = toB32(concatBytes(encodeVarint(code), encodeVarint(300), digest))
      expect(() => blake3Codec.decode(id), String(code)).toThrow(InvalidBlobIDError)
    }
    const bare = toB32(concatBytes(encodeVarint(300), digest))
    expect(() => blake3Codec.decode(bare)).toThrow(InvalidBlobIDError)
  })

  test('encodes empty content', () => {
    const digest = blake3Codec.createHasher().digest()
    expect(digest).toEqual(hexToBytes(EMPTY_HEX))
    const id = blake3Codec.encode({ digest, contentLength: 0 })
    expect(id).toBe(
      toB32(concatBytes(encodeVarint(BLAKE3_CODE), encodeVarint(0), hexToBytes(EMPTY_HEX))),
    )
    expect(blake3Codec.decode(id)).toEqual({ digest: hexToBytes(EMPTY_HEX), contentLength: 0 })
  })

  test('hasher accepts incremental updates', () => {
    const hasher = blake3Codec.createHasher()
    hasher.update(new Uint8Array([1, 2]))
    hasher.update(new Uint8Array([3]))
    expect(hasher.digest()).toEqual(digestOf(new Uint8Array([1, 2, 3])))
  })

  test('ignores contentType', () => {
    const info = sample(2)
    expect(blake3Codec.encode({ ...info, contentType: 'text/plain' })).toBe(
      blake3Codec.encode(info),
    )
    expect(blake3Codec.decode(blake3Codec.encode(info)).contentType).toBeUndefined()
  })

  test('canonicalize lowercases', () => {
    const id = blake3Codec.encode(sample(3))
    expect(blake3Codec.canonicalize(id.toUpperCase())).toBe(id)
  })

  test('rejects invalid IDs', () => {
    const valid = blake3Codec.encode(sample(1))
    const short = toB32(concatBytes(encodeVarint(BLAKE3_CODE), encodeVarint(1), new Uint8Array(31)))
    const bad = ['', 'x', '!!', short, `${valid}aa`, `${valid}a`]
    for (const id of bad) {
      expect(() => blake3Codec.decode(id), id).toThrow(InvalidBlobIDError)
      expect(() => blake3Codec.canonicalize(id), id).toThrow(InvalidBlobIDError)
    }
    expect(() => blake3Codec.decode('x')).toThrow('Invalid blob ID: "x"')
  })

  test('decode rejects uppercase and invalid base32 characters', () => {
    const valid = blake3Codec.encode(sample(1))
    for (const id of [valid.toUpperCase(), 'MY', 'm1', 'm=', 'm8', 'm-', 'm y']) {
      expect(() => blake3Codec.decode(id), id).toThrow(InvalidBlobIDError)
    }
  })

  test('decode rejects non-zero trailing bits and impossible base32 lengths', () => {
    const valid = blake3Codec.encode({ digest: new Uint8Array(32), contentLength: 0 })
    for (const id of [`${valid.slice(0, -1)}b`, 'mz', 'm']) {
      expect(() => blake3Codec.decode(id), id).toThrow(InvalidBlobIDError)
    }
  })

  test('passes conformance', () => {
    expect(() => checkCodecConformance(blake3Codec, samples)).not.toThrow()
  })
})

describe('checkCodecConformance', () => {
  const upper: BlobIDCodec = {
    ...blake3Codec,
    encode: (info) => blake3Codec.encode(info).toUpperCase(),
  }
  const dots: BlobIDCodec = { ...blake3Codec, encode: () => 'a..b' }

  test('rejects uppercase IDs', () => {
    expect(() => checkCodecConformance(upper, samples)).toThrow(Error)
  })

  test('rejects IDs containing ..', () => {
    expect(() => checkCodecConformance(dots, samples)).toThrow(/\.\./)
  })
})
