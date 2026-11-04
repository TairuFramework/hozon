import { expect, test } from 'vitest'

import * as backend from '../src/index.js'

test('exports filesystem byte storage without application locks', () => {
  expect(backend).not.toHaveProperty('createFileBlobLock')
})
