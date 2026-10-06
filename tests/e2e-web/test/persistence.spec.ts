import { expect, test } from '@playwright/test'

test('store data persists across page reload', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'Run write phase' }).click()
  await expect(page.getByText('Stores: OK')).toBeVisible({ timeout: 120_000 })

  await page.reload()
  await page.getByRole('button', { name: 'Run verify phase' }).click()
  await expect(page.getByText('Stores: OK')).toBeVisible({ timeout: 60_000 })
})
