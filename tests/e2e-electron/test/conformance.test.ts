import { expect, test } from '@playwright/test'

import { createUserDataDir, launchApp } from './launch'

test('conformance and store scenario pass on node:sqlite', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp(await createUserDataDir())
  await page.getByRole('button', { name: 'Run write phase' }).click()
  await expect(page.getByText('Conformance: OK')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Stores: OK')).toBeVisible()
  await app.close()
})
