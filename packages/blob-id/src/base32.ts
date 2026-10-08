const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(text: string): Uint8Array {
  const out: Array<number> = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) {
      throw new SyntaxError(`Invalid base32 character: ${JSON.stringify(char)}`)
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    buffer &= (1 << bits) - 1
  }
  if (bits >= 5 || buffer !== 0) {
    throw new SyntaxError('Invalid base32 length or non-zero trailing bits')
  }
  return Uint8Array.from(out)
}
