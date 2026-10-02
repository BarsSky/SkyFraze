import { test, expect, type Page } from '@playwright/test'

/**
 * Помощник в браузере: человек пишет в поле, модель просит создать главу, глава
 * появляется в проекте — и всё это видно.
 *
 * Почему сценарий такой. Проверяем не «кнопка нажимается», а весь путь целиком:
 * сообщение → запрос к провайдеру → выполнение инструмента сервером → кадр в
 * документе проекта → он же на таймлайне. Именно этот путь нельзя проверить
 * unit-тестами: там подменены и сеть, и провайдер, и документ.
 *
 * Провайдер — заглушка `stub-ollama.mjs` (её поднимает job e2e в CI), поэтому
 * модель считается локальной: ни ключа, ни согласия в сценарии не требуется.
 *
 * Если помощник на стенде выключен (или заглушки нет — локальный прогон), сценарий
 * пропускается: `npm run e2e` должен оставаться зелёным и на рабочем стенде.
 */

const EMAIL = 'assistant.e2e@example.com'
const PASSWORD = 'hunter22!'

/**
 * Вход: регистрируемся (первый администратор на чистой базе или обычная
 * регистрация, если она открыта) либо логинимся уже созданной учётной записью.
 *
 * Так сценарий работает в обоих окружениях: в CI (чистая база, режим «по заявке»)
 * — первый администратор; на стенде разработчика — своя учётная запись, если она
 * есть, иначе честный пропуск (учётку на стенде заводит администратор).
 */
async function signIn(page: Page): Promise<boolean> {
  await page.goto('/register')
  const heading = await page.locator('h1').innerText()
  if (/Первый администратор|Регистрация/.test(heading)) {
    const email = /Регистрация/.test(heading) ? `assistant+${Date.now()}@example.com` : EMAIL
    await page.getByPlaceholder('имя').fill('E2E Assistant')
    await page.getByPlaceholder('email').fill(email)
    await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
    await page.getByRole('button', { name: 'Создать' }).click()
    await expect(page).toHaveURL(/\/projects$/)
    return true
  }
  await page.goto('/login')
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  return page
    .waitForURL(/\/projects$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
}

test('помощник создаёт главу по просьбе в чате', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  // Проект заводим через интерфейс: сценарий должен идти тем же путём, что человек.
  const title = `Помощник ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  // Создание не уводит со списка: проект открывает человек, кликнув по названию.
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  // Проект пустой: панель помощника есть и здесь — как раз чтобы собрать проект с нуля.
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Открыть' }).click()

  // Помощник выключен на стенде (нет AI_ENABLED) — сценарий не имеет смысла.
  const disabled = panel.getByText('Помощник выключен на этом стенде')
  if (await disabled.isVisible().catch(() => false)) {
    test.skip(true, 'помощник выключен на стенде')
  }

  // Пока настройка не приехала, поля нет; ждём его появления.
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await expect(input).toBeEnabled({ timeout: 15_000 })

  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()

  // Ответ модели — в переписке, а «что изменилось» — отдельным блоком от сервера.
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 60_000 })
  await expect(panel.locator('[data-assistant-changes]')).toContainText('создана глава «Пролог»')

  // Главное: кадр действительно появился в проекте. Проверяем его строкой дерева:
  // заголовок в сцене лежит вне видимой области, пока прокрутка не дошла до кадра
  // (стадия — пошаговый скролл), а строка дерева в панели редакторов видна всегда.
  await expect(page.getByRole('button', { name: /01 Пролог/ })).toBeVisible({ timeout: 15_000 })
  // И текст, который прислала модель, доехал до кадра — не только заголовок.
  await expect(page.getByText('Так начинается история.').first()).toBeAttached()
})
