import { expect, test, type CDPSession, type Page } from '@playwright/test'
import { PASSWORD, signIn } from './support'

/**
 * Ключи доступа в настоящем браузере (фаза 4 плана `docs/webauthn.md`).
 *
 * Зачем отдельный сценарий, если есть семь Go-тестов. Те собирают те же байты, что присылает
 * браузер, но собирают их руками. Здесь работает НАСТОЯЩИЙ `navigator.credentials`: Chromium
 * с виртуальным аутентификатором через CDP (WebAuthn.enable + addVirtualAuthenticator) —
 * это тот же путь, которым идёт человек с отпечатком, только «палец» подтверждается сам.
 *
 * Почему файл назван `zz-`: сценарий ЗАВОДИТ второму фактору учётную запись e2e (пароля после
 * этого недостаточно). Playwright запускает файлы по алфавиту, поэтому он обязан идти
 * последним — иначе вход в остальных сценариях упирался бы во второй шаг. Ключ в конце
 * удаляется, чтобы повторный прогон на той же базе начинался с того же состояния.
 *
 * Что проверяется:
 *   - профиль показывает раздел ключей, и кнопка привязки работает;
 *   - привязка выдаёт коды восстановления (один раз — это последний путь в аккаунт);
 *   - после привязки пароля уже недостаточно: второй шаг предлагает ключ;
 *   - вход ключом доводит до проектов;
 *   - удаление ключа возвращает вход по одному паролю.
 */
test('ключ доступа: привязка в профиле, вход им и удаление', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  // Адрес мог быть зарегистрирован этим же сценарием (режим open) — берём его из состояния
  // клиента, а не угадываем: вход по ключу идёт тем же адресом.
  const email = await currentEmail(page)
  expect(email).toContain('@')

  // Ключи доступа живут на вкладке «Профиль» (0.99.0): до этого блок стоял на «Соавторах», и
  // сценарий ходил туда. Переезд сломал бы проверку молча — ключей на старой странице больше нет.
  await page.goto('/profile')
  const block = page.locator('[data-passkeys]')
  await expect(block).toBeVisible({ timeout: 30_000 })
  // Chromium умеет WebAuthn: если раздел говорит обратное — backend не настроен
  // (APP_BASE_URL не задан), и это надо видеть как отказ, а не как «пустой список».
  await expect(block).not.toContainText('не поддерживает ключи доступа')

  const cdp = await addVirtualAuthenticator(page)

  await page.getByLabel('Имя ключа').fill('виртуальный ключ')
  await page.getByRole('button', { name: /Привязать ключ/ }).click()

  const list = page.locator('[data-passkeys-list]')
  await expect(list).toContainText('виртуальный ключ', { timeout: 30_000 })

  // Коды восстановления — ровно один раз и здесь же (в базе только хеши).
  const recovery = page.locator('[data-passkey-recovery]')
  await expect(recovery).toBeVisible()
  await expect(recovery.locator('li')).toHaveCount(8)
  await page.getByRole('button', { name: 'Я сохранил коды' }).click()
  await expect(recovery).toHaveCount(0)

  // Выход и вход: пароль → второй шаг → ключ.
  // `exact` обязателен: в том же блоке есть «Выйти на всех устройствах, кроме этого», и
  // поиск по подстроке находит две кнопки.
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)

  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()

  // Пароля уже недостаточно: сервер предлагает второй шаг, и ключ — один из способов.
  await expect(page.getByText(/Пароль принят/)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Войти ключом доступа' }).click()
  await expect(page).toHaveURL(/\/projects$/, { timeout: 30_000 })

  // Уборка за собой: удаляем ключ, иначе вход по одному паролю здесь больше не работает и
  // повторный прогон на той же базе начнётся с другого состояния.
  await page.goto('/profile')
  await expect(page.locator('[data-passkeys-list]')).toContainText('виртуальный ключ', {
    timeout: 30_000,
  })

  // Журнал входов (0.66.0): вход ключом записан и виден человеку словами. Проверяется вся
  // цепочка — сервис записал попытку, ручка её отдала, интерфейс показал.
  const journal = page.locator('[data-logins-list]')
  await expect(journal).toContainText('Вход по ключу доступа', { timeout: 15_000 })
  await expect(journal).toContainText('Вход по паролю')

  await page.getByLabel('Удалить ключ виртуальный ключ').click()
  await page.getByRole('button', { name: 'Удалить' }).click()
  await expect(page.locator('[data-passkeys-empty]')).toBeVisible({ timeout: 15_000 })

  // И правда по одному паролю: после удаления ключа вход снова одношаговый.
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByPlaceholder('email').fill(email)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await expect(page).toHaveURL(/\/projects$/, { timeout: 30_000 })

  await cdp.detach()
})

/**
 * Виртуальный аутентификатор Chromium: «устройство», которое подтверждает присутствие само.
 *
 * `isUserVerified: true` — это и есть «человек приложил палец»: без него сервер (и браузер)
 * отказали бы в проверке пользователя, которую мы просим при привязке.
 */
async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
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
  return client
}

/** Адрес вошедшего человека из состояния клиента (localStorage — его же хранит zustand). */
async function currentEmail(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('skyfraze-auth')
    if (!raw) return ''
    try {
      const parsed = JSON.parse(raw) as { state?: { user?: { email?: string } } }
      return parsed?.state?.user?.email ?? ''
    } catch {
      return ''
    }
  })
}
