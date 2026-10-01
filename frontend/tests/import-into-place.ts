// Импорт «в место»: разобранный кусок md вставляется в СУЩЕСТВУЮЩИЙ проект.
//
// Проверяем обе половины, ради которых это делалось:
//
//   1. вставка попадает в CRDT-документ, а не только в таблицу событий: у
//      открытого проекта есть ЖИВАЯ комната, и запись мимо неё затёрлась бы её
//      ближайшим сохранением, а редакторы не увидели бы кусок вовсе;
//   2. место выбирается удобно: кусок можно перетащить на строку дерева в
//      панели редакторов (левая часть строки — между событиями, правая — внутрь),
//      а можно задать полями формы.
//
// Отдельно закреплено, что подключённая вкладка видит вставку БЕЗ перезагрузки:
// сервер рассылает апдейт комнаты тем же сокетом, что и правки редакторов.
//
// Запуск: npx tsx tests/import-into-place.ts   (нужен поднятый docker compose)

import { chromium, type Page } from 'playwright'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as Y from 'yjs'
import { ensureTestUser } from './helpers/testUser'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OWNER = { email: process.env.AUDIT_EMAIL ?? 'galactic.test@e.com', password: process.env.AUDIT_PASS ?? 'hunter22!' }

const problems: string[] = []
let checks = 0
const ok = (label: string, cond: boolean, detail = '') => {
  checks += 1
  if (cond) {
    console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    problems.push(`${label}${detail ? ' — ' + detail : ''}`)
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

async function api(
  token: string | null,
  method: string,
  apiPath: string,
  body?: unknown,
  extra?: Record<string, string>,
) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(extra ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* не JSON */
  }
  return { status: res.status, json }
}

/** Снапшот проекта (CRDT) — читаем настоящей Yjs, как это делает клиент. */
async function snapshot(token: string, projectId: string) {
  const res = await fetch(`${BASE}/api/projects/${projectId}/events/state`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const state = new Uint8Array(await res.arrayBuffer())
  const doc = new Y.Doc()
  if (state.byteLength > 0) Y.applyUpdate(doc, state)
  return doc.getArray<Y.Map<unknown>>('events').toArray().map((m) => ({
    id: (m.get('id') as string | undefined) ?? '',
    parentId: (m.get('parent_id') as string | undefined) ?? null,
    title: m.get('title_text') instanceof Y.Text ? (m.get('title_text') as Y.Text).toString() : ((m.get('title') as string) ?? ''),
  }))
}

/**
 * Строки таблицы событий — то, что видит выгрузка, лента и перенос.
 *
 * `GET /events` отдаёт дерево с вложенными `children`, поэтому разворачиваем его
 * в порядке отображения: так же строки лежат в таблице.
 */
async function rows(token: string, projectId: string) {
  const res = await api(token, 'GET', `/api/projects/${projectId}/events`)
  const out: Array<{ id: string; parentId: string | null; title: string; depth: number; position: number }> = []
  const walk = (nodes: any[] | undefined) => {
    for (const node of nodes ?? []) {
      out.push({
        id: String(node.id),
        parentId: (node.parent_id as string | null) ?? null,
        title: String(node.title),
        depth: Number(node.depth),
        position: Number(node.position),
      })
      walk(node.children)
    }
  }
  walk(Array.isArray(res.json) ? res.json : (res.json?.events ?? []))
  return out
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let last = false
  while (Date.now() < deadline) {
    last = await cond()
    if (last) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`  … не дождались: ${what}`)
  return last
}

/** Мультипарт-запрос импорта «в место» с полями места. */
async function importInto(
  token: string,
  projectId: string,
  files: Array<{ name: string; body: string }>,
  place: { parentId?: string; beforeId?: string; afterId?: string },
) {
  const form = new FormData()
  for (const file of files) {
    form.append('files', new Blob([file.body], { type: 'text/markdown' }), file.name)
  }
  if (place.parentId) form.append('parent_id', place.parentId)
  if (place.beforeId) form.append('before_id', place.beforeId)
  else if (place.afterId) form.append('after_id', place.afterId)
  const res = await fetch(`${BASE}/api/projects/${projectId}/import/markdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const text = await res.text()
  return { status: res.status, body: text }
}

async function uiLogin(page: Page, projectId: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', OWNER.email)
  await page.fill('input[type=password]', OWNER.password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 25000 })
  await page.goto(`${BASE}/projects/${projectId}`)
  await page.waitForSelector('.sf-topbar', { timeout: 30000 })
  await page.waitForSelector('.ed-panel', { timeout: 30000 })
  await page.waitForTimeout(1200) // сокет поднялся, документ приехал
}

/** Есть ли строка дерева с таким заголовком (без перезагрузки страницы). */
async function rowTitles(page: Page): Promise<string[]> {
  return page.$$eval('.ed-row .ed-row__name', (els) => els.map((el) => el.textContent ?? ''))
}

async function main() {
  const login = await api(null, 'POST', '/api/auth/login', OWNER)
  const token = login.json?.tokens?.access as string
  if (!token) throw new Error(`login: ${login.status}`)

  const created = await api(token, 'POST', '/api/projects', {
    title: `Импорт в место ${Date.now()}`,
    description: 'Одноразовый проект: кусок md вставляется между главами',
  })
  const projectId = created.json?.id as string
  if (!projectId) throw new Error('проект не создан')

  // Две главы и пункт у первой: «после главы» должно означать «после её пункта».
  const chapterA = crypto.randomUUID()
  const chapterA1 = crypto.randomUUID()
  const chapterB = crypto.randomUUID()
  // Проекция дерева требует базовую ревизию снапшота: у нового проекта она нулевая.
  const tree = await api(token, 'PUT', `/api/projects/${projectId}/events/tree`, [
    { id: chapterA, parent_id: null, position: 0, title: 'Глава A', body: 'Текст A.' },
    { id: chapterA1, parent_id: chapterA, position: 1, title: 'Пункт A1', body: 'Текст A1.' },
    { id: chapterB, parent_id: null, position: 2, title: 'Глава B', body: 'Текст B.' },
  ], { 'X-Skyfraze-Base-Revision': '0' })
  if (tree.status !== 200) throw new Error(`дерево проекта: ${tree.status}`)

  // Куски md во временной папке: папку выбираем в панели как обычно.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-import-'))
  const chunkFolder = path.join(dir, 'Кусок')
  fs.mkdirSync(chunkFolder)
  fs.writeFileSync(path.join(chunkFolder, '01-Вставка.md'), '---\ntitle: Вставка\ndate: 2024-05-17\n---\n\nТекст вставки.\n')
  fs.writeFileSync(path.join(chunkFolder, '01.1-Шаг.md'), '# Шаг вставки\nТело шага.\n')

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push('console: ' + m.text().slice(0, 140))
  })

  await uiLogin(page, projectId)
  const before = await rowTitles(page)
  ok('подготовка: проект открыт, дерево на месте', before.includes('Глава A') && before.includes('Глава B'), before.join(', '))

  // ── 1. Полем формы: после главы A (то есть после её пункта) ─────────────────
  const byApi = await importInto(token, projectId, [
    { name: '01-Вставка.md', body: '---\ntitle: Вставка\n---\n\nТекст вставки.\n' },
    { name: '01.1-Шаг.md', body: '# Шаг вставки\nТело шага.\n' },
  ], { afterId: chapterA })
  ok('вставка полем after_id принята', byApi.status === 201, `${byApi.status} ${byApi.body.slice(0, 120)}`)

  const gotRows = await waitFor('вставка в таблице событий', async () => {
    const list = await rows(token, projectId)
    return list.some((row) => row.title === 'Вставка')
  })
  ok('таблица событий перестроена из документа', gotRows)

  const table = await rows(token, projectId)
  const byTitle = new Map(table.map((row) => [row.title, row]))
  const insertRow = byTitle.get('Вставка')
  const stepRow = byTitle.get('Шаг вставки')
  const roots = table.filter((row) => row.parentId === null).sort((a, b) => a.position - b.position).map((r) => r.title)
  ok('кусок встал после главы A и перед главой B', JSON.stringify(roots) === JSON.stringify(['Глава A', 'Вставка', 'Глава B']), roots.join(', '))
  ok('корень куска — на верхнем уровне', !!insertRow && insertRow.parentId === null, JSON.stringify(insertRow))
  ok('под-событие куска вложено в его корень', !!insertRow && !!stepRow && stepRow.parentId === insertRow.id)
  ok('пункт главы A остался её ребёнком', byTitle.get('Пункт A1')?.parentId === chapterA)

  const doc = await snapshot(token, projectId)
  ok('вставка есть в CRDT-документе проекта', doc.some((e) => e.title === 'Вставка') && doc.some((e) => e.title === 'Шаг вставки'), doc.map((e) => e.title).join(', '))
  ok('прежние события в документе целы', doc.some((e) => e.id === chapterA) && doc.some((e) => e.id === chapterB))

  // Живая комната: обновление приходит сокетом, перезагружать страницу не нужно.
  const seen = await waitFor('вкладка увидела вставку без перезагрузки', async () => (await rowTitles(page)).includes('Вставка'), 20000)
  ok('редактор видит вставку без перезагрузки', seen, (await rowTitles(page)).join(', '))

  // ── 2. Перетаскиванием: кусок внутрь главы B ───────────────────────────────
  await page.locator('.ed-import input[type="file"]').first().setInputFiles(chunkFolder)
  await page.waitForSelector('[data-ed-chunk]', { timeout: 30000 })
  ok('панель разобрала папку и показала кусок', (await page.locator('[data-ed-chunk]').textContent())?.includes('2 события') === true)

  const target = page.locator('.ed-row', { hasText: 'Глава B' }).first()
  // Панель живёт под таймлайном: без прокрутки к ней кусок и строки остаются за
  // пределами окна, и координаты мыши попадают мимо (перетаскивание не начнётся).
  await page.locator('[data-ed-chunk]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const rowBox = await target.boundingBox()
  const chipBox = await page.locator('[data-ed-chunk]').boundingBox()
  if (!rowBox || !chipBox) throw new Error('не нашли геометрию строки или куска')
  console.log(`  … кусок ${Math.round(chipBox.x)},${Math.round(chipBox.y)}; строка ${Math.round(rowBox.x)},${Math.round(rowBox.y)} (окно ${await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`)})`)
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2)
  await page.mouse.down()
  // Правая часть строки — «внутрь» (левая половина была бы «до/после»).
  await page.mouse.move(rowBox.x + rowBox.width * 0.85, rowBox.y + rowBox.height / 2, { steps: 12 })
  await page.waitForTimeout(150)
  const hint = await page.locator('.ed-drag-note').textContent()
  ok('подсказка обещает вложить кусок внутрь', (hint ?? '').includes('вложить внутрь'), hint ?? '')
  await page.mouse.up()

  const dragged = await waitFor('вставка перетаскиванием', async () => {
    const list = await rows(token, projectId)
    return list.filter((row) => row.title === 'Вставка').length >= 2
  }, 20000)
  ok('перетаскивание вставило кусок', dragged)

  const afterDrag = await rows(token, projectId)
  const inside = afterDrag.filter((row) => row.title === 'Вставка')[1]
  ok('кусок из перетаскивания вложен внутрь главы B', inside?.parentId === chapterB, JSON.stringify(inside))
  const stepInside = afterDrag.filter((row) => row.title === 'Шаг вставки')[1]
  ok('его под-событие вложено в него', !!inside && stepInside?.parentId === inside.id)
  ok('кусок исчез из панели после вставки', (await page.locator('[data-ed-chunk]').count()) === 0)

  // ── 2.1. Слишком глубокий кусок сервер отвергает ДО записи ────────────────
  //
  // В проекте открыта живая комната, поэтому отказ приходит из неё: проверить
  // глубину после вставки уже поздно — `NormalizeTree` не примет дерево, и
  // таблица событий навсегда отстала бы от документа.
  const deepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-deep-'))
  const deepFolder = path.join(deepDir, 'Глубокий')
  fs.mkdirSync(deepFolder)
  fs.writeFileSync(path.join(deepFolder, '01-A.md'), '# A\nуровень 1\n')
  fs.writeFileSync(path.join(deepFolder, '01.1-B.md'), '# B\nуровень 2\n')
  fs.writeFileSync(path.join(deepFolder, '01.1.1-C.md'), '# C\nуровень 3\n')
  fs.writeFileSync(path.join(deepFolder, '01.1.1.1-D.md'), '# D\nуровень 4\n')

  const beforeDeep = await rows(token, projectId)
  const refused = await importInto(token, projectId, [
    { name: '01-A.md', body: '# A\nуровень 1\n' },
    { name: '01.1-B.md', body: '# B\nуровень 2\n' },
    { name: '01.1.1-C.md', body: '# C\nуровень 3\n' },
    { name: '01.1.1.1-D.md', body: '# D\nуровень 4\n' },
  ], { parentId: inside?.id })
  ok('слишком глубокий кусок отвергнут (400)', refused.status === 400, `${refused.status} ${refused.body.slice(0, 140)}`)
  ok('в отказе объяснена причина', refused.body.includes('глубже 4'), refused.body.slice(0, 140))

  const afterDeep = await rows(token, projectId)
  ok('отказ ничего не записал в таблицу', afterDeep.length === beforeDeep.length, `${beforeDeep.length} → ${afterDeep.length}`)
  const docAfter = await snapshot(token, projectId)
  ok('отказ ничего не записал в документ', docAfter.length === beforeDeep.length, `${beforeDeep.length} → ${docAfter.length}`)
  fs.rmSync(deepDir, { recursive: true, force: true })

  // ── 3. Права: постороннему — отказ ────────────────────────────────────────
  //
  // Пользователя заводим через заявку с одобрением (`ensureTestUser`): на стенде
  // с REGISTRATION_MODE=request прямая регистрация закрыта, и проверка прав молча
  // пропускалась бы — то есть не проверялась бы вовсе.
  const stranger = await ensureTestUser(
    BASE,
    `place.stranger.${Date.now()}@e.com`,
    'Посторонний Импортёр',
    OWNER,
  )
  if (stranger.ok && stranger.access) {
    const denied = await importInto(stranger.access, projectId, [{ name: '01-Чужое.md', body: '# Чужое\nтекст' }], {})
    ok('посторонний получает 403, а не 500', denied.status === 403, `${denied.status} ${denied.body.slice(0, 120)}`)
  } else {
    ok('посторонний не смог завестись — проверка прав не выполнена', false, stranger.note)
  }

  ok('в консоли страницы нет ошибок', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  await browser.close()
  fs.rmSync(dir, { recursive: true, force: true })

  console.log(`\nпроверок: ${checks}, провалов: ${problems.length}`)
  if (problems.length > 0) {
    console.log(problems.map((p) => `  FAIL ${p}`).join('\n'))
    process.exit(1)
  }
}

await main()
