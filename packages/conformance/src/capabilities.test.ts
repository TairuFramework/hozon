import { expect, test } from 'vitest'

import { supportsCase } from './capabilities.js'

test('expiry capability gates expiry independently of admission control', () => {
  const entry = { name: 'expiry', capabilities: { admissionExpiry: true }, run: async () => {} }
  expect(supportsCase(entry, { admissionControl: true })).toBe(false)
  expect(supportsCase(entry, { admissionControl: true, admissionExpiry: true })).toBe(true)
})
