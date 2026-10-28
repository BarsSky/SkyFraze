/**
 * Живая проверка картинки у упоминания (0.93.0, docs/entity-links.md §3.4.1).
 *
 * Фича: в карточке упоминания привязывается вложение проекта — «как это выглядит». Проверяем
 * весь путь человека, а не только код: карточка раскрывается из клетки матрицы, в ней есть
 * «прикрепить картинку», выбор берётся из картинок ПРОЕКТА, превью действительно загружается
 * (naturalWidth > 0, а не серая рамка), привязка видна серверу, «отвязать» её убирает.
 *
 * Проект создаётся и удаляется скриптом, поэтому стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-mention-image.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const OUT = '..\\_dev_shots\\mention-image-360.png'

/** Настоящий PNG 1×1: превью должно грузиться, а не быть битой рамкой. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage()
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
    data: { title: 'Диагностика картинки упоминания', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id
  console.log(`проект: ${projectId}`)

  try {
    const entity = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
      headers,
      data: { name: 'Анна', kind: 'character' },
    })
    if (entity.status() !== 201) problems.push(`карточка: ${entity.status()}`)
    // Два вложения: картинка и pdf. В списке выбора pdf быть не должно.
    for (const [filename, mime, buffer] of [
      ['портрет.png', 'image/png', PNG],
      ['письмо.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test')],
    ] as const) {
      const upload = await page.request.post(`${API}/api/projects/${projectId}/assets`, {
        headers,
        multipart: { file: { name: filename, mimeType: mime, buffer } },
      })
      if (upload.status() !== 201) problems.push(`вложение «${filename}»: ${upload.status()} ${await upload.text()}`)
    }

    // Кадр с упоминанием — через интерфейс: текст живёт в CRDT.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    const editorsTab = page.locator('[data-project-tab="editors"]')
    await editorsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await editorsTab.click()
    const rows = page.locator('.ed-row')
    await rows.first().waitFor({ timeout: 20_000 })
    await rows.first().click()
    await page.getByPlaceholder('Заголовок события').fill('Пролог')
    await page.locator('.ed-editor textarea').first().fill('Анна вошла в дом.')

    // Ждём проекцию: без неё «Связи» не увидят текст и матрица будет пустой. Смотрим именно
    // ту ручку, которой пользуется «Связи» (`GET /events`), а не `.md`: так проверяется тот же
    // путь, что у панели.
    const started = Date.now()
    let projected = false
    while (Date.now() - started < 90_000) {
      const rowsResponse = await page.request.get(`${API}/api/projects/${projectId}/events`, { headers })
      const rowsText = (await rowsResponse.body()).toString('utf8')
      if (rowsText.includes('Анна')) {
        projected = true
        break
      }
      await page.waitForTimeout(1000)
    }
    if (!projected) problems.push('текст кадра не доехал до сервера за 90 с')
    console.log(`проекция: ${Date.now() - started} мс`)

    await page.reload()
    const relationsTab = page.locator('[data-project-tab="relations"]')
    await relationsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await relationsTab.click()

    // Клетка матрицы раскрывает карточку упоминания (0.90.0).
    const cell = page.locator('[data-mention-card]').first()
    if ((await cell.count()) === 0) {
      const matrixCell = page.locator('.ent__matrix-link').first()
      await matrixCell.waitFor({ state: 'visible', timeout: 20_000 })
      await matrixCell.click()
    }
    const card = page.locator('[data-mention-card]')
    await card.waitFor({ state: 'visible', timeout: 20_000 })
    await card.scrollIntoViewIfNeeded()

    // 1. Карточка предлагает привязать картинку и знает, что её нет.
    const imageBlock = card.locator('[data-mention-image]')
    await imageBlock.waitFor({ state: 'visible', timeout: 10_000 })
    if ((await imageBlock.getAttribute('data-mention-image')) !== 'none') {
      problems.push(`ожидали «картинки нет», получили ${await imageBlock.getAttribute('data-mention-image')}`)
    }

    // 2. Выбор берётся из картинок проекта: pdf в списке быть не должно.
    await card.getByRole('button', { name: 'прикрепить картинку' }).click()
    const select = card.getByLabel('Картинка для упоминания')
    await select.waitFor({ state: 'visible', timeout: 15_000 })
    const options = await select.locator('option').allInnerTexts()
    console.log(`варианты: ${options.join(', ')}`)
    if (!options.some((name) => name.includes('портрет.png'))) problems.push('картинки проекта нет в выборе')
    if (options.some((name) => name.includes('письмо.pdf'))) problems.push('pdf попал в список картинок')
    await select.selectOption({ label: 'портрет.png' })
    await card.getByRole('button', { name: 'прикрепить' }).click()

    // 3. Превью действительно загрузилось.
    const preview = card.locator('[data-mention-image-preview]')
    await preview.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(500)
    const loaded = await preview.evaluate((img: HTMLImageElement) => ({
      width: img.naturalWidth,
      height: img.naturalHeight,
      src: img.currentSrc || img.src,
    }))
    console.log(`превью: ${loaded.width}×${loaded.height}, ${loaded.src.slice(0, 40)}…`)
    if (loaded.width === 0) problems.push('превью картинки не загрузилось (naturalWidth = 0)')

    // 4. Сервер знает о привязке.
    const listed = await (await page.request.get(`${API}/api/projects/${projectId}/mention-images`, { headers })).json()
    const pairs = (listed.images ?? []) as Array<{ entity_id: string; event_id: string; asset_id: string }>
    console.log(`привязок на сервере: ${pairs.length}`)
    if (pairs.length !== 1) problems.push(`на сервере ${pairs.length} привязок, ожидалась одна`)

    await page.screenshot({ path: OUT })

    // 5. «Отвязать» убирает картинку и на экране, и на сервере.
    await card.getByRole('button', { name: 'отвязать' }).click()
    await page.waitForTimeout(800)
    if ((await card.locator('[data-mention-image-preview]').count()) !== 0) {
      problems.push('после «отвязать» превью осталось')
    }
    const after = await (await page.request.get(`${API}/api/projects/${projectId}/mention-images`, { headers })).json()
    if (((after.images ?? []) as unknown[]).length !== 0) problems.push('привязка осталась на сервере')
    console.log('отвязка: чисто')
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
