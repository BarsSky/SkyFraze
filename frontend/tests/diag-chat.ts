/**
 * Живая проверка общего чата проекта (0.95.0, docs/project-chat.md).
 *
 * Проверяем путь человека, а не код: окно помощника открывается, переключается на вкладку «Чат
 * проекта», сообщение сохраняется на сервере (переживает перезагрузку), ссылка на кадр и точную
 * фразу доезжает, клик по ссылке открывает кадр в редакторах, а Нестор отвечает в чат отдельным
 * сообщением и НИЧЕГО не меняет в проекте (проверяем по числу кадров до и после).
 *
 * Нужен локальный стенд с включённым помощником (заглушка модели на 11490): без него проверка
 * бота честно скажет, что он недоступен. Проект создаётся и удаляется скриптом.
 * Запуск: cd frontend && npx tsx tests/diag-chat.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const OUT = '..\\_dev_shots\\project-chat.png'

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }

  const created = await (await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика чата', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id
  console.log(`проект: ${projectId}`)

  try {
    // Кадр — через интерфейс: текст кадра живёт в CRDT.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    const editorsTab = page.locator('[data-project-tab="editors"]')
    await editorsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await editorsTab.click()
    const row = page.locator('.ed-row').first()
    await row.waitFor({ state: 'visible', timeout: 20_000 })
    await row.click()
    await page.getByPlaceholder('Заголовок события').fill('Пролог')
    await page.locator('.ed-editor textarea').first().fill('Анна стоит на пороге. Земля ещё спит.')

    const started = Date.now()
    let projected = false
    while (Date.now() - started < 60_000) {
      const text = (await (await page.request.get(`${API}/api/projects/${projectId}/events`, { headers })).body()).toString('utf8')
      if (text.includes('Анна')) {
        projected = true
        break
      }
      await page.waitForTimeout(1000)
    }
    if (!projected) problems.push('текст кадра не доехал до сервера за 60 с')
    console.log(`проекция: ${Date.now() - started} мс`)

    // 1. Окно помощника: две вкладки, переключаемся на чат.
    await page.locator('[data-assistant-fab]').click()
    const dock = page.locator('[data-assistant-panel]')
    await dock.waitFor({ state: 'visible', timeout: 20_000 })
    await dock.locator('[data-dock-tab="chat"]').click()
    const chat = dock.locator('[data-project-chat]')
    await chat.waitFor({ state: 'visible', timeout: 10_000 })
    await chat.getByText('Пока тихо').waitFor({ state: 'visible', timeout: 10_000 })
    console.log('чат проекта: открыт, пуст')

    /** Открыть вкладку чата: окно могло остаться открытым с прошлого шага (кнопка — переключатель). */
    const openChatTab = async () => {
      const panel = page.locator('[data-assistant-panel]')
      if (!(await panel.isVisible().catch(() => false))) {
        await page.locator('[data-assistant-fab]').click()
        await panel.waitFor({ state: 'visible', timeout: 20_000 })
      }
      await panel.locator('[data-dock-tab="chat"]').click()
    }

    // 2. Сообщение без ссылки и со ссылкой на кадр + фразу.
    await chat.getByLabel('Сообщение в чат проекта').fill('Коллеги, посмотрите сцену.')
    await chat.getByRole('button', { name: 'Отправить' }).click()
    await chat.getByText('Коллеги, посмотрите сцену.').waitFor({ state: 'visible', timeout: 20_000 })

    const frameSelect = chat.getByLabel('Приложить кадр')
    await frameSelect.waitFor({ state: 'visible', timeout: 10_000 })
    // Кадры подгружаются при открытии вкладки — ждём появления «Пролога» в списке.
    await frameSelect.locator('option', { hasText: 'Пролог' }).waitFor({ state: 'attached', timeout: 20_000 })
    await frameSelect.selectOption({ label: 'Пролог' })
    await chat.getByLabel('Фраза из кадра').fill('Анна стоит на пороге')
    await chat.getByLabel('Сообщение в чат проекта').fill('Вот тут спорно.')
    await chat.getByRole('button', { name: 'Отправить' }).click()
    const link = chat.locator('[data-chat-link]').last()
    await link.waitFor({ state: 'visible', timeout: 20_000 })
    console.log(`ссылка: ${(await link.innerText()).trim()}`)
    if (!(await link.innerText()).includes('Анна стоит на пороге')) {
      problems.push('в ссылке нет цитаты')
    }

    // 3. Переживает перезагрузку: сообщения на сервере, а не в памяти окна.
    await page.reload()
    await openChatTab()
    await page.getByText('Коллеги, посмотрите сцену.').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByText('Вот тут спорно.').waitFor({ state: 'visible', timeout: 20_000 })
    console.log('после перезагрузки: оба сообщения на месте')

    // 4. Ссылка открывает кадр в редакторах.
    await page.locator('[data-chat-link]').last().click()
    await page.locator('[data-project-tab="editors"]').waitFor({ state: 'visible', timeout: 20_000 })
    const title = page.getByPlaceholder('Заголовок события')
    await title.waitFor({ state: 'visible', timeout: 20_000 })
    const titleText = await title.inputValue()
    console.log(`после клика по ссылке открыт кадр: «${titleText}»`)
    if (titleText !== 'Пролог') problems.push(`открылся не тот кадр: «${titleText}»`)

    // 4.1. Ответ на сообщение и правка своего (0.96.0).
    await openChatTab()
    const replyButton = page.locator('[data-chat-reply-button]').first()
    await replyButton.waitFor({ state: 'visible', timeout: 20_000 })
    await replyButton.click()
    await page.locator('[data-chat-reply-chip]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByLabel('Сообщение в чат проекта').fill('Это ответ на первое.')
    await page.getByRole('button', { name: 'Отправить' }).click()
    await page.getByText('Это ответ на первое.').waitFor({ state: 'visible', timeout: 20_000 })
    // Ждём цитату ожиданием, а не мгновенной проверкой: лента перерисовывается после ответа
    // сервера, и «проверил сразу» здесь уже один раз дало ложную тревогу.
    await page
      .locator('[data-chat-reply]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => problems.push('цитата ответа не появилась в ленте'))

    const editButton = page.locator('[data-chat-edit]').first()
    await editButton.waitFor({ state: 'visible', timeout: 20_000 })
    await editButton.click()
    const editArea = page.locator('.chat__edit textarea').first()
    await editArea.waitFor({ state: 'visible', timeout: 10_000 })
    await editArea.fill('Это ответ на первое (исправлено).')
    await page.locator('[data-chat-edit-save]').first().click()
    await page.getByText('Это ответ на первое (исправлено).').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByText('изменено').first().waitFor({ state: 'visible', timeout: 10_000 })
    console.log('ответ и правка: работают')

    // 4.2. Мгновенная доставка: вторая открытая вкладка того же проекта получает сообщение по
    // сокету, а не ждёт опроса (он теперь раз в 20 секунд).
    const second = await page.context().newPage()
    await second.goto(`${BASE}/projects/${projectId}`)
    await second.locator('[data-assistant-fab]').click({ timeout: 30_000 })
    const secondDock = second.locator('[data-assistant-panel]')
    await secondDock.waitFor({ state: 'visible', timeout: 20_000 })
    await secondDock.locator('[data-dock-tab="chat"]').click()
    await secondDock.locator('[data-project-chat]').waitFor({ state: 'visible', timeout: 20_000 })
    // Отправляем из первой вкладки и замеряем, за сколько сообщение появится во второй.
    const startedAt = Date.now()
    await page.getByLabel('Сообщение в чат проекта').fill('Привет из первой вкладки.')
    await page.getByRole('button', { name: 'Отправить' }).click()
    await secondDock.getByText('Привет из первой вкладки.').waitFor({ state: 'visible', timeout: 15_000 })
    const latency = Date.now() - startedAt
    console.log(`доставка во вторую вкладку: ${latency} мс`)
    if (latency > 5000) problems.push(`доставка заняла ${latency} мс — похоже, ждали опрос`)
    await second.close()

    // 5. Нестор в чате: отвечает и НЕ меняет проект.
    const framesBefore = (await (await page.request.get(`${API}/api/projects/${projectId}/events`, { headers })).json()) as unknown[]
    await openChatTab()
    const askBot = page.locator('[data-chat-ask-bot]')
    if ((await askBot.count()) === 0) {
      console.log('бот недоступен на стенде — проверка ответа пропущена (сообщение всё равно уйдёт)')
    } else {
      await askBot.click()
      await page.getByLabel('Сообщение в чат проекта').fill('Нестор, что скажешь про эту сцену?')
      await page.getByRole('button', { name: 'Отправить' }).click()
      const botMessage = page.locator('[data-chat-kind="bot"]').last()
      await botMessage.waitFor({ state: 'visible', timeout: 120_000 })
      console.log(`ответ Нестора: ${(await botMessage.innerText()).slice(0, 120).replace(/\n/g, ' ')}`)
      // Ничего не изменилось: чат — разбор, а не правка.
      const framesAfter = (await (await page.request.get(`${API}/api/projects/${projectId}/events`, { headers })).json()) as unknown[]
      if (framesAfter.length !== framesBefore.length) {
        problems.push(`бот изменил проект: кадров было ${framesBefore.length}, стало ${framesAfter.length}`)
      }
    }

    await page.screenshot({ path: OUT })
  } finally {
    const removed = await page.request.delete(`${API}/api/projects/${projectId}`, { headers })
    console.log(`уборка: проект удалён (${removed.status()})`)
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`проблемы: нет; снимок: ${OUT}`)
}

await main()
