const SEPARATOR = '\u001f'
export function encodeCategory(segments: Array<string>): string {
  for (const segment of segments) {
    if (segment.includes(SEPARATOR)) throw new TypeError('Category segment contains \\u001f')
  }
  return segments.length === 0 ? '' : `${segments.join(SEPARATOR)}${SEPARATOR}`
}
export function categoryRange(prefix: Array<string>): { gte: string; lt: string } {
  const gte = encodeCategory(prefix)
  // Advance the final separator, so every descendant sorts below the upper bound.
  return { gte, lt: `${gte.slice(0, -1)} ` }
}
