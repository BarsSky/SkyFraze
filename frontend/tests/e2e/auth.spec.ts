import { test, expect } from '@playwright/test'

test('register → login → /projects', async ({ page }) => {
  await page.goto('/register')
  await page.getByPlaceholder('имя').fill('E2E User')
  await page.getByPlaceholder('email').fill(`e2e+${Date.now()}@example.com`)
  await page.getByPlaceholder('пароль (мин. 8)').fill('hunter22!')
  await page.getByRole('button', { name: /Создать/ }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('heading', { name: /Проекты/ })).toBeVisible()
})

test('login with wrong password shows error', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('email').fill('nobody@example.com')
  await page.getByPlaceholder('пароль').fill('WRONGPASS')
  await page.getByRole('button', { name: /Войти/ }).click()
  await expect(page.getByText(/invalid|401/)).toBeVisible({ timeout: 5000 })
})
