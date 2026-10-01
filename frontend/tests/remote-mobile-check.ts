// Проверка развёрнутого стенда (192.168.13.66) с телефона: проект открывается,
// элементы меню/редактирования на месте, и создание события работает в
// незащищённом контексте (http://IP → crypto.randomUUID недоступен).
import { chromium, request } from 'playwright'
import * as fs from 'fs'
import { treeBaseRevision } from './helpers/treeProjection'

const BASE = process.env.REMOTE_URL ?? 'http://192.168.13.66'
const EMAIL = process.env.TEMP_EMAIL!
const PASS = 'hunter22!'
const OUT = 'C:/Projects/SkyFraze/_mobile_diag'
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

const api = await request.newContext({ ignoreHTTPSErrors: process.env.IGNORE_TLS === '1' })
// Пользователь создаётся на время проверки (на стенде открыт режим регистрации),
// затем удаляется отдельным шагом.
const reg = await api.post(`${BASE}/api/auth/register`, {
  data: { email: EMAIL, password: PASS, display_name: 'Mobile Check' },
})
let token: string
if (reg.status() === 201) {
  token = ((await reg.json()) as { tokens: { access: string } }).tokens.access
} else {
  const login = await api.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASS } })
  if (!login.ok()) throw new Error(`register ${reg.status()}, login ${login.status()}`)
  token = ((await login.json()) as { tokens: { access: string } }).tokens.access
}
const auth = { Authorization: `Bearer ${token}` }

// Проект с главой и под-событием — как у обычного пользователя
const title = `Mobile check ${Date.now()}`
const created = await api.post(`${BASE}/api/projects`, {
  headers: auth,
  data: { title, description: 'проверка мобильного вида' },
})
const projectId = ((await created.json()) as { id: string }).id
const chapter = crypto.randomUUID()
// Базовая ревизия снапшота обязательна: без неё проекция дерева получает 428,
// и на телефоне проверялся бы пустой проект вместо главы.
await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
  headers: { ...auth, 'X-Skyfraze-Base-Revision': await treeBaseRevision(api, BASE, projectId, auth) },
  data: [
    { id: chapter, parent_id: null, position: 0, title: 'Глава для телефона', body: 'Текст главы, чтобы копирайт был непустым.' },
  ],
})

const browser = await chromium.launch()
// Размер экрана: по умолчанию 6.1", но проверять надо и маленькие (320x568 — 4").
const [vw, vh] = (process.env.MOBILE_SIZE ?? '390x844').split('x').map(Number)
const ctx = await browser.newContext({
  viewport: { width: vw, height: vh },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  // Самоподписанный сертификат локального TLS-прокси (проверка сценария «домен за HTTPS»)
  ignoreHTTPSErrors: process.env.IGNORE_TLS === '1',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

const isHttps = BASE.startsWith('https://')
// Проверяем и сам realtime: на HTTPS-странице адрес обязан быть wss://, иначе
// браузер бросает SecurityError и роняет страницу (это и был баг с доменом).
const wsUrls: string[] = []
page.on('websocket', (ws) => wsUrls.push(ws.url()))
// Смотрим, что клиент отправляет в проекцию дерева и что отвечает сервер.
page.on('request', (r) => {
  if (r.url().includes('/events/tree')) console.log('  → PUT tree:', String(r.postData()).slice(0, 240))
})
page.on('response', async (r) => {
  if (r.url().includes('/events/tree')) console.log('  ← tree:', r.status(), (await r.text().catch(() => '')).slice(0, 140))
})
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 140))
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
const secure = (await page.evaluate(`window.isSecureContext`)) as boolean
const hasRandomUUID = (await page.evaluate(`typeof crypto.randomUUID === 'function'`)) as boolean
// Ожидания зависят от протокола: по HTTP (доступ по IP) контекст незащищённый и
// secure-context API отсутствуют; по HTTPS (домен) — наоборот.
ok(
  isHttps ? 'защищённый контекст (домен по HTTPS)' : 'незащищённый контекст (как на телефоне по IP)',
  secure === isHttps,
  `isSecureContext=${secure}, ожидалось ${isHttps}`,
)
ok(
  isHttps ? 'crypto.randomUUID есть' : 'crypto.randomUUID отсутствует',
  hasRandomUUID === isHttps,
  `randomUUID=${hasRandomUUID}, ожидалось ${isHttps}`,
)

await page.fill('input[type=email]', EMAIL)
await page.fill('input[type=password]', PASS)
await page.click('button[type=submit]')
await page.waitForURL(/projects/, { timeout: 20000 })

await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
await page.waitForSelector('.sf-root', { timeout: 25000 })
await page.waitForTimeout(2500)

const view = (await page.evaluate(`(() => {
  const q = (s) => document.querySelector(s)
  const box = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { y: Math.round(r.y), h: Math.round(r.height), vis: cs.visibility, op: Number(cs.opacity).toFixed(1) } }
  const btn = Array.from(document.querySelectorAll('.sf-topbar__actions button, .sf-topbar__actions a')).find((el) => /Редактор/i.test(el.textContent || ''))
  let hit = null
  if (btn) { const r = btn.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); hit = t ? (btn.contains(t) ? 'button' : (t.className || t.tagName)) : 'none' }
  return {
    stage: q('.sf-root')?.getAttribute('data-stage'),
    header: box('.layout header'),
    topbar: box('.sf-topbar'),
    copy: box('.sf-copy'),
    chips: box('.sf-chips'),
    editors: !!q('[data-editor-panel]'),
    editorsButtonHit: hit,
    title: q('.sf-copy__title')?.textContent || '',
    // Ищем главу по всему тексту страницы: на большом экране она не попадает
    // в первые 120 символов (шапка занимает больше места), и проверка ложно падала.
    hasChapter: document.body.innerText.includes('Глава для телефона'),
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120),
  }
})()`)) as Record<string, unknown>

console.log('  состояние:', JSON.stringify(view))
ok('страница проекта не пустая', view.hasChapter === true, String(view.text).slice(0, 100))
ok('стадия активна (не idle)', view.stage === 'active', String(view.stage))
ok('панель стадии видна', (view.topbar as { vis: string })?.vis === 'visible', JSON.stringify(view.topbar))
ok('копирайт виден', (view.copy as { vis: string })?.vis === 'visible', JSON.stringify(view.copy))
ok('кнопка «Редакторы» нажимается', view.editorsButtonHit === 'button', String(view.editorsButtonHit))
ok('редакторы в DOM', view.editors === true)

// Главное для маленьких экранов: страница НЕ масштабируется браузером (layout viewport
// равен экрану) и ничего не вылезает по горизонтали — иначе фиксированные слои уезжают.
const fit = (await page.evaluate(`(() => {
  const de = document.documentElement
  const H = window.innerHeight, W = window.innerWidth
  const rects = {}
  for (const [name, sel] of Object.entries({ header: '.layout header', topbar: '.sf-topbar', chips: '.sf-chips', copy: '.sf-copy', hint: '.sf-hint', nav: '.sf-copy__nav' })) {
    const el = document.querySelector(sel)
    if (!el) continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || r.height < 1) continue
    rects[name] = { y: Math.round(r.y), bottom: Math.round(r.bottom), right: Math.round(r.right) }
  }
  return {
    innerW: W, innerH: H, scrollW: de.scrollWidth, clientW: de.clientWidth,
    overflowX: de.scrollWidth - de.clientWidth,
    outside: Object.entries(rects).filter(([, r]) => r.y < -1 || r.bottom > H + 1 || r.right > W + 1).map(([k, r]) => k + ' y' + r.y + '..' + r.bottom + ' right' + r.right),
    rects,
  }
})()`)) as Record<string, any>
console.log('  геометрия:', JSON.stringify(fit))
ok('страница не шире экрана', fit.overflowX <= 0, `scrollWidth ${fit.scrollW} > clientWidth ${fit.clientW}`)
ok(
  'layout viewport равен экрану (нет масштабирования)',
  Math.abs(fit.innerW - vw) <= 1 && Math.abs(fit.innerH - vh) <= 1,
  `inner ${fit.innerW}x${fit.innerH}, ожидалось ${vw}x${vh}`,
)
ok('элементы стадии внутри экрана', fit.outside.length === 0, JSON.stringify(fit.outside))

// Создание события на телефоне: здесь раньше падал crypto.randomUUID.
// «+ подсобытие» создаёт ребёнка у ВЫБРАННОГО события, поэтому сначала выбираем главу.
await page.evaluate(`(() => document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' }))()`)
await page.waitForTimeout(1200)
const chapterRow = page.locator('.ed-row', { hasText: 'Глава для телефона' }).first()
if (await chapterRow.count()) {
  await chapterRow.click()
  await page.waitForTimeout(800)
}
const addSub = page.locator('.ed-toolbar button:has-text("+ подсобытие")')
if (await addSub.count()) {
  const before = (await page.evaluate(`(() => ({
    rows: document.querySelectorAll('.ed-row').length,
    crdt: window.__yjsDoc ? window.__yjsDoc.getArray('events').length : -1,
    disabled: Array.from(document.querySelectorAll('.ed-toolbar button')).map((b) => (b.textContent || '').trim() + ':' + (b.disabled ? 'off' : 'on')),
  }))()`)) as Record<string, unknown>
  console.log('  до клика:', JSON.stringify(before))
  await addSub.first().click()
  await page.waitForTimeout(8000)
  const after = (await page.evaluate(`(() => ({
    rows: document.querySelectorAll('.ed-row').length,
    crdt: window.__yjsDoc ? window.__yjsDoc.getArray('events').length : -1,
    note: document.querySelector('[data-sync-note]')?.textContent || '',
    body: document.body.innerText.replace(/\\s+/g, ' ').slice(-160),
  }))()`)) as Record<string, unknown>
  console.log('  после клика:', JSON.stringify(after))
  // /events отдаёт ВЛОЖЕННОЕ дерево: под-событие лежит в children корня.
  const tree = (await (await api.get(`${BASE}/api/projects/${projectId}/events`, { headers: auth })).json()) as Array<{
    title: string
    children?: unknown[]
  }>
  const total = tree.reduce((n, node) => n + 1 + (node.children?.length ?? 0), 0)
  ok(
    'создание под-события на телефоне работает',
    total >= 2 && (tree[0]?.children?.length ?? 0) >= 1,
    `корней: ${tree.length}, всего с потомками: ${total}, в CRDT: ${after.crdt}`,
  )
} else {
  problems.push('нет кнопки «+ подсобытие» в редакторах')
}

await page.screenshot({ path: `${OUT}/remote-mobile-project.png` })
ok('нет ошибок в консоли', errors.length === 0, errors.slice(0, 3).join(' | '))

// Realtime: на HTTPS ожидаем wss://, на HTTP — ws://. Отсутствие соединения не ошибка
// (контент грузится по REST), но схема обязана совпадать с протоколом страницы.
const collab = wsUrls.filter((u) => u.includes('/collab'))
console.log('  websocket:', JSON.stringify(collab))
if (collab.length) {
  ok(
    `адрес realtime — ${isHttps ? 'wss' : 'ws'}://`,
    isHttps ? collab.every((u) => u.startsWith('wss://')) : collab.every((u) => u.startsWith('ws://')),
    collab.join(', '),
  )
} else {
  notes.push('realtime-соединение не открывалось (страница работает по REST)')
}
ok('страница не пустая при HTTPS/HTTP (нет SecurityError)', errors.every((e) => !/SecurityError/i.test(e)), errors.join(' | '))

// уборка
await api.delete(`${BASE}/api/projects/${projectId}`, { headers: auth })
await api.dispose()
await browser.close()

console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
process.exit(problems.length ? 1 : 0)
