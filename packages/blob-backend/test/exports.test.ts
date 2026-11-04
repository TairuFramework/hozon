import { expect, test } from 'vitest'

import * as backend from '../src/index.js'

test('exports byte storage without application locks', () => {
  expect(backend).not.toHaveProperty('createMemoryBlobLock')
  expect(backend).not.toHaveProperty('BlobLockTimeoutError')
})
