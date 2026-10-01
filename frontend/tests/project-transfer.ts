// Перенос проекта между стендами: экспорт архива в интерфейсе → удаление
// исходного проекта (имитация «другого стенда») → импорт архива → проверка,
// что главы, вложенность и картинки на месте, а повторный импорт объясняет отказ.
//
// Запуск: npx tsx tests/project-transfer.ts   (нужен поднятый docker compose)

import { chromium, request, type APIRequestContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { treeBaseRevision } from './helpers/treeProjection'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = 'C:/Projects/SkyFraze/_transfer_shots'
const USER = { email: process.env.AUDIT_EMAIL ?? 'galactic.test@e.com', password: process.env.AUDIT_PASS ?? 'hunter22!' }

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const problems: string[] = []
const notes: string[] = []
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    notes.push(label)
    console.log(`  ok   ${label}`)
  } else {
    problems.push(`${label}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

async function apiToken(api: APIRequestContext): Promise<string> {
  const res = await api.post(`${BASE}/api/auth/login`, { data: USER })
  if (!res.ok()) throw new Error(`login: ${res.status()}`)
  return ((await res.json()) as { tokens: { access: string } }).tokens.access
}

async function uiLogin(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', USER.email)
  await page.fill('input[type=password]', USER.password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 20000 })
}

async function main() {
  const browser = await chromium.launch()
  const api = await request.newContext()
  const token = await apiToken(api)
  const auth = { Authorization: `Bearer ${token}` }

  // ── исходный проект с главой, под-событием и вложением
  const stamp = Date.now()
  const title = `Transfer ${stamp}`

  // Подчищаем остатки прошлых прогонов: упавший тест не должен копить проекты
  // на стенде и мешать проверкам количества карточек.
  const existing = (await (await api.get(`${BASE}/api/projects`, { headers: auth })).json()) as Array<{
    id: string
    title: string
  }>
  for (const p of existing.filter((item) => item.title.startsWith('Transfer '))) {
    await api.delete(`${BASE}/api/projects/${p.id}`, { headers: auth })
  }

  const created = await api.post(`${BASE}/api/projects`, {
    headers: auth,
    data: { title, description: 'проект для проверки переноса' },
  })
  ok('проект создан через API', created.ok(), `статус ${created.status()}`)
  const project = (await created.json()) as { id: string }
  const projectId = project.id

  // Дерево через проекцию CRDT-дерева (тот же путь, что использует редактор).
  // Базовая ревизия обязательна: без неё сервер отвечает 428.
  const chapter = crypto.randomUUID()
  const child = crypto.randomUUID()
  const tree = await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
    headers: { ...auth, 'X-Skyfraze-Base-Revision': await treeBaseRevision(api, BASE, projectId, auth) },
    data: [
      { id: chapter, parent_id: null, position: 0, title: 'Глава переноса', body: 'текст главы для проверки' },
      { id: child, parent_id: chapter, position: 1, title: 'Под-событие переноса', body: 'текст под-события' },
    ],
  })
  ok('дерево событий сохранено', tree.ok(), `статус ${tree.status()}`)

  // Вложение: маленький PNG как «картинка проекта».
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoC251gfbC0iCpmkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4NfYAAT8B1WQAAAAASUVORK5CYII=',
    'base64',
  )
  const upload = await api.post(`${BASE}/api/projects/${projectId}/assets`, {
    headers: auth,
    multipart: { file: { name: 'перенос.png', mimeType: 'image/png', buffer: png } },
  })
  ok('вложение загружено', upload.ok(), `статус ${upload.status()}`)

  // ── экспорт через интерфейс
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  await uiLogin(page)
  const card = page.locator('.list .card', { hasText: title }).first()
  await card.waitFor({ timeout: 20000 })
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
  await card.locator('button:has-text("Экспорт")').click()
  const download = await downloadPromise
  const archive = path.join(OUT, 'project.skyfraze.zip')
  await download.saveAs(archive)
  const size = fs.statSync(archive).size
  ok('архив скачался из интерфейса', size > 500, `${size} байт, имя ${download.suggestedFilename()}`)
  ok('имя файла — .skyfraze.zip', download.suggestedFilename().endsWith('.skyfraze.zip'), download.suggestedFilename())
  await page.screenshot({ path: `${OUT}/projects-with-export.png` })

  // ── «другой стенд»: удаляем исходный проект (иначе импорт справедливо откажет)
  const del = await api.delete(`${BASE}/api/projects/${projectId}`, { headers: auth })
  ok('исходный проект удалён (имитация другого стенда)', del.status() === 204, `статус ${del.status()}`)
  await page.reload({ waitUntil: 'networkidle' })
  ok('проект исчез из списка', (await page.locator('.list .card', { hasText: title }).count()) === 0)

  // ── импорт архива через интерфейс
  await page.setInputFiles('.pub-import input[type=file]', archive)
  await page.waitForTimeout(2500)
  const noteText = await page.locator('.pub-note').innerText().catch(() => '')
  ok('интерфейс сообщил о переносе', /перенесён/i.test(noteText), noteText.slice(0, 120))
  ok('в сообщении есть счётчики', /событий 2/.test(noteText) && /вложений 1/.test(noteText), noteText.slice(0, 140))
  await page.screenshot({ path: `${OUT}/after-import.png` })

  const cards = page.locator('.list .card', { hasText: title })
  ok('импортированный проект появился в списке', (await cards.count()) === 1, `карточек ${await cards.count()}`)

  // ── содержимое перенеслось: открываем проект и проверяем кадры
  await cards.first().locator('h3 a').click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
  const newId = page.url().split('/').pop() as string
  await page.waitForSelector('.sf-root', { timeout: 25000 })
  await page.waitForTimeout(2500)
  const restored = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    const title = document.querySelector('.sf-copy__title')
    return {
      frames: Number(root.getAttribute('data-frames-in-chapter')),
      frameTitle: title ? title.textContent : '',
      body: document.querySelector('.sf-copy__body') ? document.querySelector('.sf-copy__body').textContent : '',
    }
  })()`)) as { frames: number; frameTitle: string; body: string }
  ok('в импортированном проекте та же глава', /Глава переноса/.test(restored.frameTitle), restored.frameTitle)
  ok('текст главы перенёсся', /текст главы для проверки/.test(restored.body ?? ''), (restored.body ?? '').slice(0, 60))

  // вложенность и вложение: смотрим редактор и ассеты проекта
  const events = (await (await api.get(`${BASE}/api/projects/${newId}/events`, { headers: auth })).json()) as Array<{
    title: string
    children: unknown[]
  }>
  const chapterNode = events.find((e) => /Глава переноса/.test(e.title))
  ok('иерархия перенеслась', !!chapterNode && chapterNode.children.length === 1, JSON.stringify(events.map((e) => e.title)))
  const assets = (await (await api.get(`${BASE}/api/projects/${newId}/assets`, { headers: auth })).json()) as Array<{
    filename: string
    size: number
  }>
  ok('вложение перенеслось', assets.length === 1 && assets[0].size === png.length, JSON.stringify(assets))
  ok('имя файла сохранилось', assets[0]?.filename === 'перенос.png', assets[0]?.filename ?? '')

  // ── повторный импорт того же архива объясняет отказ
  const importAgain = await api.post(`${BASE}/api/projects/import`, {
    headers: auth,
    multipart: { file: { name: 'project.skyfraze.zip', mimeType: 'application/zip', buffer: fs.readFileSync(archive) } },
  })
  ok('повторный импорт отклонён (409)', importAgain.status() === 409, `статус ${importAgain.status()}`)
  const errBody = (await importAgain.json()) as { error?: string }
  ok('текст ошибки объясняет причину', /уже импортирован/i.test(errBody.error ?? ''), errBody.error ?? '')

  // ── мусорный файл отклоняется понятно
  const junk = await api.post(`${BASE}/api/projects/import`, {
    headers: auth,
    multipart: { file: { name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('не архив') } },
  })
  ok('мусорный файл отклонён (400)', junk.status() === 400, `статус ${junk.status()}`)

  // уборка: удаляем импортированный проект
  await api.delete(`${BASE}/api/projects/${newId}`, { headers: auth })

  await api.dispose()
  await browser.close()

  console.log('\n=== ПЕРЕНОС ПРОЕКТА ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
