import { test, expect } from '@playwright/test'

/**
 * Дымовые сценарии входа, которым НЕ нужна пустая база: неверный пароль и закрытые
 * страницы.
 *
 * Первая регистрация переехала в install.spec.ts: она обязана идти до всех остальных
 * сценариев (отдельный проект `install` в playwright.config.ts) и в CI не имеет права
 * пропускаться. Здесь её держать нельзя — файлы идут по алфавиту, и к этому моменту
 * администратора уже регистрирует кто-то другой, поэтому проверка молча пропускалась.
 */
test('login with wrong password shows error', async ({ page }) => {
  await page.goto('/login')
  await page.getByPlaceholder('email').fill('nobody@example.com')
  await page.getByPlaceholder('пароль').fill('WRONGPASS')
  await page.getByRole('button', { name: /Войти/ }).click()
  // Текст ошибки — из интерфейса (src/pages/LoginPage.tsx): сервер отвечает 401,
  // и человек видит объяснение на русском, а не код состояния.
  await expect(page.getByText('Неверный email или пароль')).toBeVisible({ timeout: 10_000 })
})

test('защищённые страницы закрыты без входа', async ({ page }) => {
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/login/)
})
