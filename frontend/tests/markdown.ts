// Markdown в тексте события: окно редактирования с предпросмотром, таблицы,
// формулы, диаграммы — и то же самое на публичной странице истории.
//
// Запуск: npx tsx tests/markdown.ts      (стенд: http://localhost)
import { chromium, request, type Page } from 'playwright'
import * as fs from 'fs'
import { treeBaseRevision } from './helpers/treeProjection'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const EMAIL = process.env.MD_EMAIL ?? 'galactic.test@e.com'
const PASS = process.env.MD_PASS ?? 'hunter22!'
const OUT = 'C:/Projects/SkyFraze/_md_shots'
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

const MARKDOWN = [
  '## Прибытие',
  '',
  'Корабль вышел на орбиту **АнуВаара** — *двести лет* полёта позади.',
  '',
  '- топлива на один рейс',
  '- фильтры забиты пылью',
  '',
  '| Узел | Состояние |',
  '| --- | --- |',
  '| Реактор | в норме |',
  '| Фильтры | забиты |',
  '',
  'Радиус посадки: $r = \\sqrt{h^2 + d^2}$.',
  '',
  '$$E = mc^2$$',
  '',
  '```mermaid',
  'graph TD',
  '  A[Орбита] --> B{Посадка}',
  '  B -->|да| C[Колония]',
  '  B -->|нет| A',
  '```',
  '',
  '<img src=x onerror="window.__mdXss = 1">',
  '',
  '[опасная ссылка](javascript:window.__mdXss = 2)',
].join('\n')

const api = await request.newContext()
const login = await api.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASS } })
if (!login.ok()) throw new Error(`login ${login.status()}`)
const token = ((await login.json()) as { tokens: { access: string } }).tokens.access
const auth = { Authorization: `Bearer ${token}` }

const created = await api.post(`${BASE}/api/projects`, {
  headers: auth,
  data: { title: `Markdown Test ${Date.now()}`, description: 'проверка разметки' },
})
const projectId = ((await created.json()) as { id: string }).id
const chapter = crypto.randomUUID()
// Проекция дерева требует базовую ревизию снапшота: без неё сервер отвечает 428,
// проект остаётся пустым и страница показывает пустой таймлайн вместо главы.
await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
  headers: { ...auth, 'X-Skyfraze-Base-Revision': await treeBaseRevision(api, BASE, projectId, auth) },
  data: [{ id: chapter, parent_id: null, position: 0, title: 'Глава с разметкой', body: 'Черновой текст.' }],
})

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const page: Page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push('console: ' + m.text().slice(0, 140))
})

await page.goto(`${BASE}/login`)
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASS)
await page.click('button[type="submit"]')
await page.waitForURL(/projects/, { timeout: 25000 })
await page.goto(`${BASE}/projects/${projectId}`)
await page.waitForSelector('.sf-root', { timeout: 25000 })
await page.waitForTimeout(1500)

// ── окно редактора
await page.click('button:has-text("Открыть редактор Markdown")')
await page.waitForSelector('.md-editor', { timeout: 15000 })
ok('окно редактора открылось', true)
const hasPreview = await page.locator('.md-editor__preview').count()
ok('предпросмотр есть в окне', hasPreview === 1)

// Панель вставок: таблица, формула и диаграмма добавляются кнопками.
await page.fill('.md-editor__textarea', 'Проверка вставок.')
await page.click('.md-editor__toolbar button:has-text("таблица")')
await page.click('.md-editor__toolbar button[title*="отдельной строкой"]')
await page.click('.md-editor__toolbar button:has-text("диаграмма")')
const afterTools = await page.inputValue('.md-editor__textarea')
ok('кнопка «таблица» вставила таблицу', /\|\s*Столбец 1\s*\|/.test(afterTools), afterTools.slice(0, 80))
ok('кнопка «формула» вставила выключную формулу', afterTools.includes('$$\nE = mc^2\n$$'), afterTools.slice(-60))
ok('кнопка «диаграмма» вставила mermaid', afterTools.includes('```mermaid'))

// Живой предпросмотр обновляется по мере набора.
await page.fill('.md-editor__textarea', MARKDOWN)
await page.waitForTimeout(700)
await page.waitForSelector('.md-editor__preview table', { timeout: 15000 })
const preview = (await page.evaluate(`(() => ({
  table: !!document.querySelector('.md-editor__preview table'),
  rows: document.querySelectorAll('.md-editor__preview table tr').length,
  katex: document.querySelectorAll('.md-editor__preview .katex').length,
  math: document.querySelectorAll('.md-editor__preview .sf-md-math').length,
  heading: document.querySelector('.md-editor__preview h2')?.textContent || '',
  strong: !!document.querySelector('.md-editor__preview strong'),
  script: document.querySelectorAll('.md-editor__preview script').length,
  onerror: document.querySelectorAll('.md-editor__preview [onerror]').length,
  jsLink: Array.from(document.querySelectorAll('.md-editor__preview a')).some((a) => (a.getAttribute('href') || '').startsWith('javascript:')),
}))()`)) as Record<string, unknown>
console.log('  предпросмотр:', JSON.stringify(preview))
ok('предпросмотр: таблица собрана', preview.table === true && Number(preview.rows) >= 3)
ok('предпросмотр: заголовок второго уровня', preview.heading === 'Прибытие', String(preview.heading))
ok('предпросмотр: жирный текст', preview.strong === true)
ok('предпросмотр: формулы отрисованы KaTeX', Number(preview.math) >= 2 && Number(preview.katex) >= 2, JSON.stringify(preview))
ok('предпросмотр: скриптов нет', preview.script === 0 && preview.onerror === 0)
ok('предпросмотр: javascript-ссылки нет', preview.jsLink === false)
await page.screenshot({ path: `${OUT}/editor.png` })

// Диаграмма рисуется лениво загруженным Mermaid.
await page.waitForSelector('.md-editor__preview .sf-md-mermaid svg', { timeout: 30000 }).catch(() => undefined)
const diagram = (await page.evaluate(`(() => {
  const node = document.querySelector('.md-editor__preview .sf-md-mermaid')
  return { svg: !!node?.querySelector('svg'), error: !!node?.classList.contains('sf-md-mermaid--error'), text: (node?.textContent || '').slice(0, 40) }
})()`)) as Record<string, unknown>
ok('предпросмотр: диаграмма нарисована', diagram.svg === true, JSON.stringify(diagram))

// ── сохранение и кадр таймлайна
await page.keyboard.press('Control+Enter')
await page.waitForSelector('.md-editor', { state: 'detached', timeout: 15000 })
ok('окно закрылось по Ctrl+Enter', true)

/**
 * Тело главы в таблице событий.
 *
 * Ждём: у открытого проекта строки `events` пишет СЕРВЕР из своего документа
 * (Фаза 4) — раз в 5 секунд при изменениях, а не на каждое нажатие. Клиент в этот
 * момент снапшот и дерево не пишет вовсе, поэтому «прочитал сразу после Ctrl+Enter»
 * означало бы «прочитал до того, как сервер успел сохранить».
 */
async function bodyOnServer(): Promise<string> {
  const deadline = Date.now() + 25000
  let body = ''
  while (Date.now() < deadline) {
    const stored = (await (
      await api.get(`${BASE}/api/projects/${projectId}/events`, { headers: auth })
    ).json()) as Array<{ body?: string }>
    body = stored[0]?.body ?? ''
    if (body.includes('## Прибытие')) return body
    await new Promise((r) => setTimeout(r, 500))
  }
  return body
}

const storedBody = await bodyOnServer()
ok('текст сохранён на сервере', storedBody.includes('## Прибытие'), storedBody.slice(0, 60))

await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = 0 })()`)
await page.waitForTimeout(900)
await page.waitForSelector('.sf-copy__body table', { timeout: 20000 }).catch(() => undefined)
const frame = (await page.evaluate(`(() => {
  const body = document.querySelector('.sf-copy__body')
  return {
    present: !!body,
    table: !!body?.querySelector('table'),
    katex: body ? body.querySelectorAll('.katex').length : 0,
    math: body ? body.querySelectorAll('.sf-md-math').length : 0,
    heading: body?.querySelector('h2')?.textContent || '',
    diagram: !!body?.querySelector('.sf-md-mermaid svg'),
    list: body ? body.querySelectorAll('li').length : 0,
    xss: window.__mdXss || 0,
  }
})()`)) as Record<string, unknown>
console.log('  кадр:', JSON.stringify(frame))
ok('кадр: разметка отрисована', frame.present === true && frame.table === true)
ok('кадр: заголовок и список', frame.heading === 'Прибытие' && Number(frame.list) >= 2, JSON.stringify(frame))
ok('кадр: формулы отрисованы', Number(frame.math) >= 2 && Number(frame.katex) >= 2, JSON.stringify(frame))
ok('кадр: диаграмма нарисована', frame.diagram === true)
ok('кадр: инъекция не сработала', frame.xss === 0, `__mdXss=${frame.xss}`)
await page.screenshot({ path: `${OUT}/frame.png` })

// ── публичная страница истории глазами анонима
const published = await api.post(`${BASE}/api/projects/${projectId}/publication`, {
  headers: auth,
  data: { is_public: true },
})
const slug = ((await published.json()) as { public_slug?: string }).public_slug ?? ''
ok('история опубликована', slug.length > 0, slug)

const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const anonPage = await anon.newPage()
const anonErrors: string[] = []
anonPage.on('pageerror', (e) => anonErrors.push(e.message))
await anonPage.goto(`${BASE}/s/${slug}`)
await anonPage.waitForSelector('.sf-root', { timeout: 25000 })
await anonPage.waitForTimeout(2500)
await anonPage.waitForSelector('.sf-copy__body table', { timeout: 20000 }).catch(() => undefined)
const publicView = (await anonPage.evaluate(`(() => {
  const body = document.querySelector('.sf-copy__body')
  return {
    table: !!body?.querySelector('table'),
    katex: body ? body.querySelectorAll('.katex').length : 0,
    editors: document.querySelectorAll('[data-editor-panel]').length,
    xss: window.__mdXss || 0,
  }
})()`)) as Record<string, unknown>
console.log('  публичная страница:', JSON.stringify(publicView))
ok('публичная страница: разметка и формулы', publicView.table === true && Number(publicView.katex) >= 2, JSON.stringify(publicView))
ok('публичная страница: редакторов нет', publicView.editors === 0)
ok('публичная страница: без ошибок', anonErrors.length === 0, anonErrors.slice(0, 2).join(' | '))
await anonPage.screenshot({ path: `${OUT}/public.png` })
await anon.close()

ok('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

// ── то же окно на маленьком экране: полный экран, без горизонтального выезда,
//    переключение «текст → предпросмотр» работает, кнопка сохранения доступна
const mobile = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' })
const mobilePage = await mobile.newPage()
const mobileErrors: string[] = []
mobilePage.on('pageerror', (e) => mobileErrors.push(e.message))
await mobilePage.goto(`${BASE}/login`)
await mobilePage.fill('input[type="email"]', EMAIL)
await mobilePage.fill('input[type="password"]', PASS)
await mobilePage.click('button[type="submit"]')
await mobilePage.waitForURL(/projects/, { timeout: 25000 })
await mobilePage.goto(`${BASE}/projects/${projectId}`)
await mobilePage.waitForSelector('.sf-root', { timeout: 25000 })
await mobilePage.waitForTimeout(1200)
await mobilePage.click('button:has-text("Открыть редактор Markdown")')
await mobilePage.waitForSelector('.md-editor', { timeout: 15000 })
const mobileLayout = (await mobilePage.evaluate(`(() => {
  const win = document.querySelector('.md-editor__window')
  const r = win.getBoundingClientRect()
  const save = Array.from(document.querySelectorAll('.md-editor__foot button')).find((b) => /Сохранить/.test(b.textContent || ''))
  let hit = null
  if (save) {
    const sr = save.getBoundingClientRect()
    const el = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2)
    hit = el ? (save.contains(el) ? 'button' : (el.className || el.tagName)) : 'none'
  }
  return {
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(','),
    saveHit: hit,
  }
})()`)) as Record<string, unknown>
console.log('  телефон:', JSON.stringify(mobileLayout))
ok('окно занимает экран без выезда по горизонтали', Number(mobileLayout.doc) <= Number(mobileLayout.win) + 1, JSON.stringify(mobileLayout))
ok('кнопка «Сохранить» нажимается на телефоне', mobileLayout.saveHit === 'button', String(mobileLayout.saveHit))
await mobilePage.click('.md-editor__modes button:has-text("Только предпросмотр")')
await mobilePage.waitForTimeout(500)
const mobilePreview = (await mobilePage.evaluate(`(() => ({
  previewVisible: getComputedStyle(document.querySelector('.md-editor__pane--preview')).display !== 'none',
  editHidden: getComputedStyle(document.querySelector('.md-editor__pane--edit')).display === 'none',
  table: !!document.querySelector('.md-editor__preview table'),
}))()`)) as Record<string, unknown>
ok('на телефоне предпросмотр показывается вместо текста', mobilePreview.previewVisible === true && mobilePreview.editHidden === true && mobilePreview.table === true, JSON.stringify(mobilePreview))
await mobilePage.screenshot({ path: `${OUT}/editor-mobile.png` })
ok('на телефоне без ошибок в консоли', mobileErrors.length === 0, mobileErrors.slice(0, 2).join(' | '))
await mobile.close()

await browser.close()
await api.delete(`${BASE}/api/projects/${projectId}`, { headers: auth })
await api.dispose()

console.log(`\nпроверок: ${notes.length}, ошибок: ${problems.length}`)
for (const p of problems) console.log(`  ! ${p}`)
process.exit(problems.length ? 1 : 0)
