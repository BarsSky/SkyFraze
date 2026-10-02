import { test, expect } from '@playwright/test'
import { signIn } from './support'

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
 * Вход общий с другими сценариями (tests/e2e/support.ts): администратора на чистой
 * базе регистрирует первый файл по алфавиту. Если войти нечем — сценарий пропускается:
 * `npm run e2e` должен оставаться зелёным и на рабочем стенде.
 *
 * Запас времени у этого сценария больше общего (60 с): ответ модели ждём до 60 с
 * (в CI провайдер — заглушка, но на стенде это настоящая модель), а появление кадра
 * в дереве — до 30 с.
 */
test.setTimeout(120_000)

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

  // Проект пустой: плавающий помощник есть и здесь — как раз чтобы собрать проект с нуля.
  // Кнопка всегда в углу экрана, поэтому окно не зависит от прокрутки и слоёв стадии.
  const fab = page.locator('[data-assistant-fab]')
  await expect(fab).toBeVisible()
  await fab.click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()

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

  // Главное: кадр действительно появился в проекте. Проверяем строкой дерева в панели
  // редакторов: заголовок в сцене лежит вне видимой области, пока прокрутка не дошла до
  // кадра (стадия — пошаговый скролл), а строка дерева видна всегда. Селектор по классу
  // строки, а не по тексту: «01 Пролог» есть и в чипах глав стадии — по тексту проверка
  // ловила бы два элемента и падала на строгом режиме.
  //
  // Запас по времени здесь больше, чем у остальных проверок: строка появляется не из
  // ответа запроса, а из апдейта документа, который сервер рассылает по WebSocket
  // (collab.Hub.InsertLive → broadcast), плюс перерисовка панели. Доставку апдейта
  // подключённому клиенту проверяет Go-тест TestHubInsertLive; здесь же к ней
  // добавляется браузер. На загруженном раннере CI этого не хватило: сценарий падал
  // на 15 секундах, а в следующем прогоне тот же шаг занимал 1.6 с (падение «помощник
  // создаёт главу» в CI 2026-10-02 — 1 из ~12 прогонов).
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 30_000,
  })
  // И текст, который прислала модель, доехал до кадра — не только заголовок.
  await expect(page.getByText('Так начинается история.').first()).toBeAttached()

  // Окно закрывается и снова открывается — переписка на месте: оно прячется, а не
  // размонтируется, иначе человек терял бы историю при каждом сворачивании.
  await panel.locator('[data-assistant-close]').click()
  await expect(panel).toBeHidden()
  await fab.click()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible()
})

/**
 * Приложенная картинка доезжает до провайдера.
 *
 * Проверяем весь путь файла: выбор в браузере → чтение в data URL → тело запроса →
 * проверка «модель видит картинки» на сервере → провайдер. Заглушка отвечает про
 * картинку только тогда, когда получила её в запросе, поэтому «Вижу картинку» в чате и
 * есть доказательство, что изображение не потерялось по дороге.
 */
test('картинка к вопросу доезжает до модели', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Картинка ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })

  // Кнопка прикрепления есть: заглушка объявляет себя зрячей (capabilities: vision).
  // Настоящая картинка 1×1: подделывать формат нельзя — сервер проверяет base64.
  await panel.locator('[data-assistant-file]').setInputFiles({
    name: 'маяк.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  })
  await expect(panel.locator('[data-assistant-attach] img')).toBeVisible()

  await input.fill('Что на картинке?')
  await panel.getByRole('button', { name: 'Спросить' }).click()

  await expect(panel.getByText('Вижу картинку: на ней маяк.')).toBeVisible({ timeout: 60_000 })
  // После отправки превью исчезает: картинка была для одного вопроса.
  await expect(panel.locator('[data-assistant-attach]')).toHaveCount(0)
})
