import type { SQLiteDatabase } from 'expo-sqlite'
import { expect, test, vi } from 'vitest'

import { ExpoDriver } from '../src/driver.js'

test('destroy waits for the held connection and for the close itself', async () => {
  let finishClose = () => {}
  const destroy = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve
      }),
  )
  const driver = new ExpoDriver({ database: {} as SQLiteDatabase, destroy })
  await driver.acquireConnection()

  let destroyed = false
  const destroying = driver.destroy().then(() => {
    destroyed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(destroy).not.toHaveBeenCalled()

  await driver.releaseConnection()
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
  expect(destroyed).toBe(false)

  finishClose()
  await destroying
  expect(destroyed).toBe(true)
})
