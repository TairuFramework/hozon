import { expect, test } from '@playwright/test'

import { createUserDataDir, launchApp } from './launch'

test('store data persists across an app restart', async () => {
  test.setTimeout(180_000)
  const userDataDir = await createUserDataDir()
  const first = await launchApp(userDataDir)
  await first.page.getByRole('button', { name: 'Run write phase' }).click()
  await expect(first.page.getByText('Stores: OK')).toBeVisible({ timeout: 120_000 })
  await first.app.close()

  // Fresh process, same userData directory.
  const second = await launchApp(userDataDir)
  await second.page.getByRole('button', { name: 'Run verify phase' }).click()
  await expect(second.page.getByText('Stores: OK')).toBeVisible({ timeout: 120_000 })
  await second.app.close()
})
