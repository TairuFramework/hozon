import { expect, test } from '@playwright/test'

test('conformance and store scenario pass on OPFS', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Run write phase' }).click()
  await expect(page.getByText('Conformance: OK')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Stores: OK')).toBeVisible()
})
