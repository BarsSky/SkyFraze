import { expect, type Page } from '@playwright/test'

/**
 * Вход для сценариев e2e на чистой базе.
 *
 * Зачем общий помощник, а не копия в каждом файле. Сценарии идут по алфавиту, и
 * администратора на пустой базе регистрирует первый из них; остальные должны войти
 * ТОЙ ЖЕ учётной записью, иначе они честно пропускаются — и проверка, ради которой
 * файл написан, не выполняется вовсе (так и вышло с первым вариантом сценария
 * загрузки: в CI он пропускался бы всегда).
 *
 * Правила:
 *   * форма «Первый администратор» — регистрируем фиксированный адрес;
 *   * форма «Регистрация» (режим open) — регистрируем новый уникальный адрес;
 *   * иначе (заявки по email) — входим фиксированным адресом, а если его нет,
 *     возвращаем `false`: вызывающий сценарий пропускается.
 */
const PASSWORD = 'hunter22!'

/** Адрес, который регистрирует первый сценарий и которым пользуются остальные. */
export const E2E_ADMIN_EMAIL = 'assistant.e2e@example.com'

export async function signIn(page: Page, email: string = E2E_ADMIN_EMAIL): Promise<boolean> {
  await page.goto('/register')
  const heading = await page.locator('h1').innerText()

  if (/Первый администратор/.test(heading)) {
    await register(page, email)
    return true
  }
  if (/Регистрация/.test(heading)) {
    // Режим open: заводим свой адрес, чтобы не зависеть от чужих данных на стенде.
    await register(page, `e2e+${Date.now()}@example.com`)
    return true
  }

  await page.goto('/login')
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  return page
    .waitForURL(/\/projects$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
}

async function register(page: Page, email: string): Promise<void> {
  await page.getByPlaceholder('имя').fill('E2E User')
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
  await page.getByRole('button', { name: 'Создать' }).click()
  await expect(page).toHaveURL(/\/projects$/)
}
