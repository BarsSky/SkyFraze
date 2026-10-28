/**
 * Живой инструмент: снимки профиля и второго шага входа для ВИЗУАЛЬНОЙ проверки.
 *
 * В CI не гоняется (как и остальные `tests/*.ts`): ему нужны браузер, поднятый backend и
 * поднятый vite. Зато он ловит то, чего не видят ни unit-тесты, ни e2e — наезжающие друг на
 * друга строки, обрезанный текст, кнопку за краем на узком экране. Так и нашлось в 0.66.1, что
 * человек с ключом и без TOTP не мог ввести код восстановления: разметка была верной, а пути
 * в интерфейсе не было.
 *
 * Запуск (backend на :8181 и vite на :5173 уже подняты, база предпочтительно пустая):
 *   npx tsx tests/visual-profile.ts
 *
 * Снимки: visual-desktop.png, visual-mobile.png, visual-login-2fa.png в текущем каталоге
 * (в git не попадают). Повторный прогон на той же базе упрётся во второй шаг входа: после
 * привязки ключа одного пароля уже недостаточно.
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = 'visual.profile@example.com'
const PASSWORD = 'hunter22!'

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  // Порядок важен: после привязки ключа вход одним паролем уже не завершается (ключ — второй
  // фактор), поэтому журнал наполняем ДО привязки, а ключ привязываем уже внутри сессии.
  await registerIfPossible(page)
  if (await isLoggedIn(page)) await logout(page)
  await makeFailedAttempt(page)
  await signIn(page)
  await attachPasskey(page)

  await page.goto(`${BASE}/profile`)
  const section = page.locator('[data-two-factor]')
  await section.waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('[data-logins-list]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('[data-passkeys-list]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(500)
  await section.screenshot({ path: 'visual-desktop.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await section.screenshot({ path: 'visual-mobile.png' })

  await page.setViewportSize({ width: 1280, height: 900 })
  await logout(page)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.getByText(/Пароль принят/).waitFor({ state: 'visible', timeout: 20_000 })
  await page.screenshot({ path: 'visual-login-2fa.png' })

  await browser.close()
  console.log('снимки готовы')
}

async function registerIfPossible(page: Page) {
  await page.goto(`${BASE}/register`)
  const heading = await page.locator('h1').innerText()
  if (!/Первый администратор|Регистрация/.test(heading)) return
  await page.getByPlaceholder('имя').fill('Визуальный Профиль')
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
  await page.getByRole('button', { name: 'Создать' }).click()
  // На повторном прогоне адрес уже занят — это не ошибка скрипта, дальше просто вход.
  await Promise.race([
    page.waitForURL(/\/projects$/, { timeout: 15_000 }),
    page.waitForTimeout(15_000),
  ]).catch(() => {})
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

async function attachPasskey(page: Page) {
  await page.goto(`${BASE}/profile`)
  await page.locator('[data-passkeys]').waitFor({ state: 'visible', timeout: 20_000 })
  if (await page.locator('[data-passkeys-list]').count()) return

  const client = await page.context().newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: false,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.getByLabel('Имя ключа').fill('ноутбук (виртуальный)')
  await page.getByRole('button', { name: /Привязать ключ/ }).click()
  await page.locator('[data-passkeys-list]').waitFor({ state: 'visible', timeout: 20_000 })
  const saved = page.getByRole('button', { name: 'Я сохранил коды' })
  if (await saved.count()) await saved.click()
  await client.detach()
}

async function makeFailedAttempt(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill('WRONG-PASSWORD')
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.getByText(/Неверный email или пароль/).waitFor({ state: 'visible', timeout: 20_000 })
}

/** Вошли ли мы: состояние хранит zustand в localStorage. */
async function isLoggedIn(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('skyfraze-auth')
    if (!raw) return false
    try {
      const parsed = JSON.parse(raw) as { state?: { accessToken?: string } }
      return Boolean(parsed?.state?.accessToken)
    } catch {
      return false
    }
  })
}

/** Выход из аккаунта: кнопка в шапке появляется не мгновенно после навигации. */
async function logout(page: Page) {
  const button = page.getByRole('button', { name: 'Выйти', exact: true })
  await button.waitFor({ state: 'visible', timeout: 20_000 })
  await button.click()
  await page.waitForURL(/\/login/, { timeout: 20_000 })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
