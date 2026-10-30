import { test, expect, type Page } from '@playwright/test'
import { apiHeaders, openEditorsTab, signIn } from './support'

/**
 * Подтверждение приёма правки сервером (0.140.0).
 *
 * Что проверяется здесь, а не в юнит-тестах. До 0.140.0 доказательством «сервер получил» был
 * `readyState === OPEN`, а он врёт (прокси без `Upgrade`, полуоткрытое соединение). Поэтому клиент
 * писал состояние по REST раз в 10 секунд тишины — с окном потери до 10 секунд и лишним PUT на
 * каждые 10 секунд печати. Теперь сервер подтверждает каждый апдейт номером, и тест проверяет три
 * вещи сразу:
 *
 *   1. подтверждения приходят по сокету и относятся именно к нашей печати
 *      (`__collabAcks.confirmed()` вырос после набора текста);
 *   2. ни одной записи снапшота по REST за всю сессию — включая окно тишины в 12 секунд (на две
 *      секунды дольше `SNAP_CONFIRM_MS`), в котором до 0.140.0 таймер срабатывал бы;
 *   3. сервер видит текст: `GET /events` отдаёт его из документа комнаты.
 *
 * Учёт подтверждений открыт наружу так же, как `__yjsDoc` и `__presence`: по сокету нельзя
 * «посмотреть глазами», доехала ли правка.
 */
test.setTimeout(180_000)

/** Сколько тишины проверяем — на две секунды дольше, чем `SNAP_CONFIRM_MS` в провайдере. */
const QUIET_WINDOW_MS = 12_000
/** Фраза, которую печатаем: по ней же ищем текст на сервере. */
const PHRASE = 'Фраза, которую сервер обязан подтвердить.'

/** Сколько подтверждений пришло и сколько ещё ждём. */
async function ackStats(page: Page): Promise<{ size: number; confirmed: number }> {
  return page.evaluate(() => {
    const acks = (window as { __collabAcks?: { size(): number; confirmed(): number } }).__collabAcks
    return { size: acks?.size() ?? 0, confirmed: acks?.confirmed() ?? 0 }
  })
}

test('правка доезжает до сервера подтверждением, и снапшот по REST больше не пишется', async ({
  page,
}) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  /** Записи снапшота по REST: до 0.140.0 их давал таймер в 10 секунд. */
  const snapshotPuts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/events/state')) {
      snapshotPuts.push(request.url())
    }
  })

  const title = `Подтверждение ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  const projectURL = page.url()
  expect(projectURL).toMatch(/\/projects\/[0-9a-f-]+$/)
  const projectId = projectURL.split('/').pop()

  await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 60_000 })
  await openEditorsTab(page)
  const row = page.locator('.ed-row').first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  await page.getByPlaceholder('Заголовок события').fill('Глава с подтверждением')

  // Засев проекта (создание главы, заголовок) тоже уходит апдейтами — считаем их базой, чтобы
  // «подтверждения выросли» относилось именно к печати ниже.
  const baseline = (await ackStats(page)).confirmed

  // Печатаем настоящими клавишами: правка должна уйти в CRDT теми же апдейтами, что у человека.
  const body = page.locator('.ed-form textarea').first()
  await body.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(PHRASE)

  // 1. Подтверждения идут: сервер принял апдейты и ответил номерами.
  await expect
    .poll(async () => (await ackStats(page)).confirmed, { timeout: 30_000, intervals: [200, 500, 1000] })
    .toBeGreaterThan(baseline)

  // Ждать больше нечего: все отправленные номера подтверждены.
  await expect
    .poll(async () => (await ackStats(page)).size, { timeout: 30_000, intervals: [200, 500, 1000] })
    .toBe(0)

  // 2. Окно тишины: подтверждения снимают надобность в страховке по REST.
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(
    snapshotPuts,
    `PUT /events/state за сессию: ${snapshotPuts.join(', ') || 'нет'} — с подтверждениями их быть не должно`,
  ).toEqual([])

  // 3. Сервер видит текст без ожидания тика комнаты (0.139.0) — и это тот же текст, что принят.
  //
  // Опрос, а не один запрос: `GET /events` читает документ комнаты, а комната могла только-только
  // собраться (ровно поэтому до 0.139.0 здесь стояла проекция, отставшая на тик). Полминуты
  // терпения — это про доставку документа, а не про подтверждение: оно проверено выше и строго.
  //
  // Разбор отказа важнее самого отказа: пустое дерево означает «на сервере кадров нет», а дерево
  // с прежним текстом — «до сервера доехало не то». Поэтому в сообщении и `GET /events`, и
  // выгрузка (у неё свой путь чтения живого документа), и то, что осталось в поле кадра.
  const headers = await apiHeaders(page)
  const readEvents = async () => {
    const response = await page.request.get(`/api/projects/${projectId}/events`, { headers })
    return { status: response.status(), text: await response.text() }
  }
  await expect
    .poll(async () => (await readEvents()).text.includes(PHRASE), {
      timeout: 30_000,
      intervals: [500, 1000, 2000],
    })
    .toBe(true)
    .catch(async () => {
      const last = await readEvents()
      const markdown = await (
        await page.request.get(`/api/projects/${projectId}/export.md`, { headers })
      ).text()
      const fieldText = await body.inputValue().catch(() => '(поля нет)')
      const rows = await page.locator('.ed-row').count()
      throw new Error(
        `GET /events не содержит набранный текст (статус ${last.status}).\n` +
          `GET /events: ${last.text.slice(0, 600)}\n` +
          `export.md: ${markdown.slice(0, 600)}\n` +
          `поле кадра: ${JSON.stringify(fieldText.slice(0, 200))}\n` +
          `кадров в списке редакторов: ${rows}\n` +
          `PUT /events/state за сессию: ${snapshotPuts.join(', ') || 'нет'}`,
      )
    })
})


