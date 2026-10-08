/** Encode a non-negative safe integer as unsigned LEB128. */
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Invalid varint value: ${n}`)
  }
  const out: Array<number> = []
  let rest = n
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return Uint8Array.from(out)
}

/** Decode an unsigned LEB128 safe integer starting at `offset`. */
export function decodeVarint(bytes: Uint8Array, offset = 0): { value: number; length: number } {
  let value = 0
  let multiplier = 1
  for (let i = offset; i < bytes.length; i++) {
    const byte = bytes[i] as number
    value += (byte & 0x7f) * multiplier
    if (!Number.isSafeInteger(value)) {
      throw new RangeError('Varint exceeds safe integer range')
    }
    if ((byte & 0x80) === 0) {
      return { value, length: i - offset + 1 }
    }
    multiplier *= 0x80
  }
  throw new RangeError('Truncated varint')
}
