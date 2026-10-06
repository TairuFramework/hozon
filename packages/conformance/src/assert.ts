export function equal(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
  }
}

export function ok(value: unknown): asserts value {
  if (!value) throw new Error(`Expected truthy value, received ${String(value)}`)
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  if (
    actual == null ||
    expected == null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  )
    return false
  if (actual instanceof Date || expected instanceof Date) {
    return (
      actual instanceof Date &&
      expected instanceof Date &&
      Object.is(actual.getTime(), expected.getTime())
    )
  }
  if (actual instanceof Uint8Array || expected instanceof Uint8Array) {
    return (
      actual instanceof Uint8Array &&
      expected instanceof Uint8Array &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    )
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) return false
  if (Array.isArray(actual) && Array.isArray(expected) && actual.length !== expected.length)
    return false
  const actualKeys = Object.keys(actual)
  const expectedKeys = Object.keys(expected)
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key) =>
        Object.hasOwn(expected, key) &&
        matches(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
        ),
    )
  )
}

export function deepEqual(actual: unknown, expected: unknown): void {
  if (!matches(actual, expected)) throw new Error('Expected deeply equal values')
}

export async function rejects(
  fn: () => Promise<unknown>,
  expected: (new (...args: Array<never>) => Error) | string,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (typeof expected === 'string') {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes(expected))
        throw new Error(`Expected rejection containing ${expected}, received ${message}`, {
          cause: error,
        })
    } else if (!(error instanceof expected)) {
      throw new Error(`Expected rejection of type ${expected.name}, received ${String(error)}`, {
        cause: error,
      })
    }
    return
  }
  throw new Error('Expected rejection, but operation resolved')
}
