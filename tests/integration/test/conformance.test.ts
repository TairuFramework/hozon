import { runConformance, summarize } from '@hozon/conformance'
import { afterEach, describe, expect, test } from 'vitest'

import { backends } from '../src/backends.js'

describe.each(backends())('$name', (backend) => {
  afterEach(() => backend.cleanup())

  test('full conformance suite passes on the real backend', async () => {
    const results = await runConformance({
      capabilities: backend.capabilities,
      createAdapter: () => backend.createAdapter(),
      cleanup: () => backend.cleanup(),
    })
    expect(results.filter((result) => !result.ok)).toEqual([])
    expect(summarize(results).ok).toBe(true)
    const names = results.map((result) => result.name)
    const writerCases = [
      'transaction contract: queued writer waits, active tx proceeds',
      'transaction contract: autocommit queues separately and survives rollback',
    ]
    const queuedReadCases = [
      'transaction contract: outside read queues until commit and sees committed rows',
      'transaction contract: outside read queues until rollback and sees pre-transaction state',
    ]
    if (backend.name === 'node-sqlite') {
      expect(names).toEqual(expect.arrayContaining([...writerCases, ...queuedReadCases]))
    } else {
      for (const name of [...writerCases, ...queuedReadCases]) expect(names).not.toContain(name)
      expect(names).toEqual(
        expect.arrayContaining([
          'transaction contract: reads outside tx see last committed state',
          'transaction contract: compareWrite uses supplied connection',
        ]),
      )
    }
    // Integration-tier coverage the spec lists, provided by the conformance cases.
    expect(results.map((result) => result.name)).toEqual(
      expect.arrayContaining([
        'stores: cross-store writes roll back atomically',
        'stores: failed telemetry delete rolls back log deletion',
        'lifecycle: close before first query',
        'lifecycle: double close',
      ]),
    )
  })
})
