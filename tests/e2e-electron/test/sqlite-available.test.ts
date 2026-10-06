import { expect, test } from '@playwright/test'

import { createUserDataDir, launchApp } from './launch'

test('node:sqlite is available in the Electron main process', async () => {
  const { app, page } = await launchApp(await createUserDataDir())
  const check = await page.evaluate(() => window.hozon.sqliteCheck())
  console.log(`Electron versions: ${JSON.stringify(check.versions)}`)
  expect(check.error).toBeUndefined()
  expect(check.ok).toBe(true)
  await app.close()
})
