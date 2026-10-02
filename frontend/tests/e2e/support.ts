import { expect, type Page } from '@playwright/test'

/**
 * Вход для сценариев e2e на чистой базе.
 *
 * Зачем общий помощник, а не копия в каждом файле. Администратора на пустой базе
 * регистрирует сценарий первой регистрации (`install.spec.ts`), остальные должны войти
 * ТОЙ ЖЕ учётной записью, иначе они честно пропускаются — и проверка, ради которой
 * файл написан, не выполняется вовсе (так и вышло с первым вариантом сценария
 * загрузки: в CI он пропускался бы всегда).
 *
 * Правила:
 *   * форма «Первый администратор» — регистрируем фиксированный адрес;
 *   * форма «Регистрация» (режим open) — регистрируем новый уникальный адрес;
 *   * иначе (заявки по email) — входим фиксированным адресом, а если его нет,
 *     в CI это ПРОВАЛ, а локально — пропуск сценария (`false`).
 *
 * Почему в CI провал, а не пропуск: пропуск выглядит зелёным, и именно так регрессия
 * «на чистой базе нет первого администратора» прожила незамеченной целый релиз —
 * пять e2e-сценариев вместо проверки рапортовали «skipped».
 */
const PASSWORD = 'hunter22!'

/** Адрес, который регистрирует первый сценарий и которым пользуются остальные. */
export const E2E_ADMIN_EMAIL = 'assistant.e2e@example.com'

export { PASSWORD }

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
  const ok = await page
    .waitForURL(/\/projects$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

  if (!ok && process.env.CI) {
    throw new Error(
      `не удалось войти как ${email}: в CI это не «пропуск», а провал — сценарий за этой ` +
        'строкой проверяет именно то, ради чего написан. Скорее всего не сработала первая ' +
        'регистрация (install.spec.ts) или изменился пароль в support.ts.',
    )
  }
  return ok
}

async function register(page: Page, email: string): Promise<void> {
  await page.getByPlaceholder('имя').fill('E2E User')
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
  await page.getByRole('button', { name: 'Создать' }).click()
  await expect(page).toHaveURL(/\/projects$/)
}
