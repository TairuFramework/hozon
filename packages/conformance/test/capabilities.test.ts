import { expect, test } from 'vitest'

import { supportsCase } from '../src/capabilities.js'
import { transactionContractCases } from '../src/cases/transaction-contract.js'

test('native transaction capability defaults off and combines with other requirements', () => {
  const entry = {
    name: 'native transaction',
    capabilities: { nativeTransactions: true, concurrentReaders: true },
    run: async () => {},
  }
  expect(supportsCase(entry)).toBe(false)
  expect(supportsCase(entry, { concurrentReaders: true })).toBe(false)
  expect(supportsCase(entry, { nativeTransactions: true })).toBe(false)
  expect(supportsCase(entry, { nativeTransactions: true, concurrentReaders: true })).toBe(true)
  expect(supportsCase({ ...entry, capabilities: { nativeTransactions: false } })).toBe(true)
  expect(
    supportsCase(
      { ...entry, capabilities: { nativeTransactions: false } },
      { nativeTransactions: true },
    ),
  ).toBe(false)
})

test('native transaction cases require the native capability', () => {
  const cases = transactionContractCases.filter((entry) => entry.capabilities?.nativeTransactions)
  expect(cases.length).toBeGreaterThan(0)
  for (const entry of cases) {
    expect(supportsCase(entry)).toBe(false)
    expect(supportsCase(entry, { nativeTransactions: true })).toBe(true)
  }
})
