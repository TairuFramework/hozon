import { describe, expect, test } from 'vitest'

import { base32Encode } from '../src/base32.js'
import { blake3Codec } from '../src/blake3.js'
import { checkCodecConformance } from '../src/conformance.js'
import { InvalidBlobIDError } from '../src/errors.js'
import type { BlobIDCodec, BlobIDInfo } from '../src/types.js'
import { encodeVarint } from '../src/varint.js'

const EMPTY_HEX = 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

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

  test('encodes empty content', () => {
    const digest = blake3Codec.createHasher().digest()
    expect(digest).toEqual(hexToBytes(EMPTY_HEX))
    const id = blake3Codec.encode({ digest, contentLength: 0 })
    expect(id).toBe(base32Encode(concat(encodeVarint(0), hexToBytes(EMPTY_HEX))))
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
    const short = base32Encode(concat(encodeVarint(1), new Uint8Array(31)))
    const bad = ['', 'x', '!!', short, `${valid}aa`, `${valid}a`]
    for (const id of bad) {
      expect(() => blake3Codec.decode(id), id).toThrow(InvalidBlobIDError)
      expect(() => blake3Codec.canonicalize(id), id).toThrow(InvalidBlobIDError)
    }
    expect(() => blake3Codec.decode('x')).toThrow('Invalid blob ID: "x"')
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
