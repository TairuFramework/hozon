import { expect, test } from 'vitest'

import { supportsCase } from './capabilities.js'
import { transactionContractCases } from './cases/transaction-contract.js'

test('expiry capability gates expiry independently of admission control', () => {
  const entry = { name: 'expiry', capabilities: { admissionExpiry: true }, run: async () => {} }
  expect(supportsCase(entry, { admissionControl: true })).toBe(false)
  expect(supportsCase(entry, { admissionControl: true, admissionExpiry: true })).toBe(true)
})

test('single-writer scheduling is opt-in independently of concurrent readers', () => {
  const entry = {
    name: 'writer queue',
    capabilities: { singleWriter: true },
    run: async () => {},
  }
  expect(supportsCase(entry)).toBe(false)
  expect(supportsCase(entry, { concurrentReaders: true })).toBe(false)
  expect(supportsCase(entry, { singleWriter: true })).toBe(true)
  expect(supportsCase(entry, { singleWriter: true, concurrentReaders: true })).toBe(true)
})

test.each([
  'transaction contract: queued writer waits, active tx proceeds',
  'transaction contract: autocommit queues separately and survives rollback',
])('%s requires single-writer scheduling on both SQLite reader profiles', (name) => {
  const entry = transactionContractCases.find((entry) => entry.name === name)
  expect(entry).toBeDefined()
  if (!entry) throw new Error(`Missing case: ${name}`)
  expect(supportsCase(entry, { concurrentReaders: true })).toBe(false)
  expect(supportsCase(entry, { singleWriter: true })).toBe(true)
  expect(supportsCase(entry, { singleWriter: true, concurrentReaders: true })).toBe(true)
})
