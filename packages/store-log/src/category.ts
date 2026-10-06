const SEPARATOR = '\u001f'
export function encodeCategory(segments: Array<string>): string {
  for (const segment of segments) {
    if (segment.includes(SEPARATOR)) throw new TypeError('Category segment contains \\u001f')
  }
  return segments.length === 0 ? '' : `${segments.join(SEPARATOR)}${SEPARATOR}`
}
export function categoryRange(prefix: Array<string>): { gte: string; lt: string } {
  const gte = encodeCategory(prefix)
  // U+10FFFF sorts above supplementary-plane descendants such as emoji.
  return { gte, lt: `${gte.slice(0, -1)}\u{10ffff}` }
}
