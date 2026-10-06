import { describe, expect, test } from 'vitest'

import { PostgresAdapter } from '../src/index.js'

describe('PostgresAdapter', () => {
  test('has postgres kind', () => {
    const adapter = new PostgresAdapter({ url: 'postgres://user:pass@localhost:5432/db' })
    expect(adapter.kind).toBe('postgres')
    return adapter.close()
  })

  test('constructs without connecting', () => {
    const adapter = new PostgresAdapter({ url: 'postgres://user:pass@127.0.0.1:1/db' })
    expect(adapter.dialect).toBeDefined()
    return adapter.close()
  })

  test('applies int8 parser configuration while preserving caller parsers', () => {
    const customParser = {
      to: 20,
      from: [20],
      serialize: (value: bigint) => value.toString(),
      parse: (value: string) => BigInt(value),
    }
    const adapter = new PostgresAdapter({
      url: 'postgres://user:pass@127.0.0.1:1/db',
      options: { types: { int8: customParser } },
    })
    expect(adapter.dialect).toBeDefined()
    return adapter.close()
  })

  test('keeps boolean filter values native for postgres.js serialization', () => {
    const adapter = new PostgresAdapter({ url: 'postgres://user:pass@127.0.0.1:1/db' })
    expect(adapter.coerceFilterValue(true)).toBe(true)
    expect(adapter.coerceFilterValue(false)).toBe(false)
    expect(adapter.coerceFilterValue('text')).toBe('text')
    return adapter.close()
  })

  test('close before use resolves and is idempotent', async () => {
    const adapter = new PostgresAdapter({ url: 'postgres://user:pass@127.0.0.1:1/db' })
    await expect(adapter.close?.()).resolves.toBeUndefined()
    await expect(adapter.close?.()).resolves.toBeUndefined()
  })
})
