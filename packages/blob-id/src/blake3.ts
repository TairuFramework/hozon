import { blake3 } from '@noble/hashes/blake3.js'
import { fromB32, toB32 } from '@sozai/codec'

import { InvalidBlobIDError } from './errors.js'
import type { BlobHasher, BlobIDCodec, BlobIDInfo } from './types.js'
import { decodeVarint, encodeVarint } from './varint.js'

// Multicodec `blake3`. Leading the ID so another hash can coexist under a new code.
const CODE = 0x1e
const CODE_PREFIX = encodeVarint(CODE)
const DIGEST_LENGTH = 32

function encode(info: BlobIDInfo): string {
  if (info.digest.length !== DIGEST_LENGTH) {
    throw new RangeError(`Expected a ${DIGEST_LENGTH}-byte digest, got ${info.digest.length}`)
  }
  const length = encodeVarint(info.contentLength)
  const bytes = new Uint8Array(CODE_PREFIX.length + length.length + DIGEST_LENGTH)
  bytes.set(CODE_PREFIX, 0)
  bytes.set(length, CODE_PREFIX.length)
  bytes.set(info.digest, CODE_PREFIX.length + length.length)
  return toB32(bytes)
}

function decode(id: string): BlobIDInfo {
  try {
    const bytes = fromB32(id)
    const code = decodeVarint(bytes)
    if (code.value !== CODE) {
      throw new RangeError(`Unexpected codec code ${code.value}`)
    }
    const { value, length } = decodeVarint(bytes, code.length)
    const offset = code.length + length
    if (bytes.length !== offset + DIGEST_LENGTH) {
      throw new RangeError('Unexpected ID length')
    }
    return { digest: bytes.slice(offset), contentLength: value }
  } catch (cause) {
    throw new InvalidBlobIDError(id, { cause })
  }
}

function canonicalize(id: string): string {
  const lower = id.toLowerCase()
  if (encode(decode(lower)) !== lower) {
    throw new InvalidBlobIDError(id)
  }
  return lower
}

/** Default codec: `varint(0x1e) || varint(contentLength) || BLAKE3-256 digest`, lowercase base32. */
export const blake3Codec: BlobIDCodec = {
  code: CODE,
  digestLength: DIGEST_LENGTH,
  createHasher(): BlobHasher {
    const hasher = blake3.create({})
    return {
      update: (bytes) => {
        hasher.update(bytes)
      },
      digest: () => hasher.digest(),
    }
  },
  encode,
  decode,
  canonicalize,
}
