/** Logical names stay within PostgreSQL's identifier limit without truncation. */
export function assertSearchIndex(index: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(index)) {
    throw new Error(`Invalid search index name: ${JSON.stringify(index)}`)
  }
}

/** FTS5 reserves internal columns and its table name, case-insensitively. */
export function assertSearchFields(fields: Array<string>, index: string): void {
  if (fields.length === 0 || fields.length > 499) {
    throw new RangeError('Search requires 1 to 499 fields')
  }
  const seen = new Set<string>()
  for (const field of fields) {
    const normalised = field.toLowerCase()
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field) ||
      /^(entry_key|rank|rowid)$/i.test(field) ||
      normalised === index.toLowerCase() ||
      seen.has(normalised)
    ) {
      throw new Error(`Invalid search field name: ${JSON.stringify(field)}`)
    }
    seen.add(normalised)
  }
}
