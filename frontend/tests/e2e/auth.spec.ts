import { test, expect } from '@playwright/test'

/**
 * Дымовые сценарии входа — то, что проверяется в CI на ЧИСТОЙ базе.
 *
 * Почему именно так. Этот файл — единственное, что запускает `npm run e2e`
 * (playwright.config.ts смотрит только `*.spec.ts`); остальные сценарии в
 * `tests/*.ts` — ручные инструменты разработчика: у них вписаны адреса и учётные
 * записи конкретного стенда.
 *
 * Рассчитывать на пустую инсталляцию можно только в CI: там postgres поднимается
 * заново, а первый зарегистрированный становится администратором. На рабочем
 * стенде пользователи уже есть, поэтому сценарий регистрации честно пропускается,
 * а не падает (иначе `npm run e2e` локально всегда красный).
 */
test('register → login → /projects (чистая инсталляция)', async ({ page }) => {
  await page.goto('/register')
  // Пустая инсталляция: форма создаёт первого администратора. Если идёт «Заявка на
  // доступ», база не пустая — этот сценарий здесь не имеет смысла.
  const heading = await page.locator('h1').innerText()
  test.skip(!/Первый администратор/.test(heading), `инсталляция не пустая: «${heading}»`)

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
  // Текст ошибки — из интерфейса (src/pages/LoginPage.tsx): сервер отвечает 401,
  // и человек видит объяснение на русском, а не код состояния.
  await expect(page.getByText('Неверный email или пароль')).toBeVisible({ timeout: 10_000 })
})

test('защищённые страницы закрыты без входа', async ({ page }) => {
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/login/)
})
