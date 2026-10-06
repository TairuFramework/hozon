import { runConformance, summarize } from '@hozon/conformance'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

describe.each(backends())('$name', (backend) => {
  afterEach(() => backend.cleanup())

  test('full conformance suite passes on the real backend', async () => {
    const results = await runConformance({
      createAdapter: () => backend.createAdapter(),
      cleanup: () => backend.cleanup(),
    })
    expect(results.filter((result) => !result.ok)).toEqual([])
    expect(summarize(results).ok).toBe(true)
  })
})
