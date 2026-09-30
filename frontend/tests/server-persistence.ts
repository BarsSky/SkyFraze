// Фаза 3: снапшот пишет сервер, а не клиенты.
//
// Проверяется главное, ради чего фаза делалась: пока у клиентов открыт сокет, они
// НЕ пишут снапшот по REST — состояние держит и сохраняет сервер (документ комнаты,
// один писатель). Здесь это проверяется буквально: считаем PUT /events/state из
// браузеров (должно быть ноль) и убеждаемся, что снапшот в базе обновилcя и содержит
// правки обоих авторов.
//
// Запуск: npx tsx tests/server-persistence.ts   (нужен поднятый docker compose)

import { chromium, type BrowserContext, type Page } from 'playwright'
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

async function api(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
  return { status: res.status, json, headers: res.headers }
}

/** Снапшот из базы + его ревизия. */
async function snapshot(token: string, projectId: string) {
  const res = await fetch(`${BASE}/api/projects/${projectId}/events/state`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const buf = new Uint8Array(await res.arrayBuffer())
  const revision = Number(res.headers.get('X-Skyfraze-Revision') ?? '0')
  return { state: buf, revision }
}

/** Текст главы прямо из снапшота — читаем настоящей Yjs, как это делает клиент. */
function bodyFromSnapshot(state: Uint8Array, eventId: string): string {
  const doc = new Y.Doc()
  if (state.byteLength > 0) Y.applyUpdate(doc, state)
  const map = doc.getArray<Y.Map<unknown>>('events').toArray().find((m) => m.get('id') === eventId)
  if (!map) return ''
  const text = map.get('body_text')
  if (text instanceof Y.Text) return text.toString()
  return (map.get('body') as string | undefined) ?? ''
}

async function uiLogin(page: Page, projectId: string, email: string, password: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 25000 })
  await page.goto(`${BASE}/projects/${projectId}`)
  await page.waitForSelector('.ed-panel', { timeout: 30000 })
}

async function selectEvent(page: Page, title: string) {
  await page.locator('.ed-row', { hasText: title }).first().click()
  await page.waitForSelector('.ed-form', { timeout: 15000 })
  await page.waitForTimeout(400)
}

async function main() {
  const login = await api(null, 'POST', '/api/auth/login', OWNER)
  const ownerToken = login.json?.tokens?.access as string
  if (!ownerToken) throw new Error(`login владельца: ${login.status}`)

  const created = await api(ownerToken, 'POST', '/api/projects', {
    title: `Серверный писатель ${Date.now()}`,
    description: 'Одноразовый проект: снапшот пишет сервер',
  })
  const projectId = created.json?.id as string
  if (!projectId) throw new Error('проект не создан')

  const chapterTitle = `Глава сервера ${Date.now()}`
  const original = 'Общее начало истории.'
  const event = await api(ownerToken, 'POST', `/api/projects/${projectId}/events`, {
    title: chapterTitle,
    body: original,
  })
  const eventId = event.json?.id as string
  const before = await snapshot(ownerToken, projectId)
  ok('подготовка: проект создан, снапшота ещё нет', before.revision === 0, `ревизия ${before.revision}`)

  const peerEmail = `server.peer.${Date.now()}@e.com`
  const peerName = 'Борис Сервер'
  const peer = await ensureTestUser(BASE, peerEmail, peerName, OWNER)
  if (!peer.ok || !peer.access) throw new Error('второй пользователь не создан: ' + peer.note)
  const me = await api(peer.access, 'GET', '/api/auth/me')
  await api(ownerToken, 'POST', `/api/projects/${projectId}/members`, { user_id: me.json?.id, role: 'editor' })

  const browser = await chromium.launch()
  const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const ctxB: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const clientPuts: string[] = []
  const pageErrors: string[] = []

  try {
    const pageA = await ctxA.newPage()
    pageA.on('pageerror', (e) => pageErrors.push(`владелец: ${e.message}`))
    pageA.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/events/state')) clientPuts.push(`A ${req.url()}`)
    })
    const pageB = await ctxB.newPage()
    pageB.on('pageerror', (e) => pageErrors.push(`редактор: ${e.message}`))
    pageB.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/events/state')) clientPuts.push(`B ${req.url()}`)
    })

    await uiLogin(pageA, projectId, OWNER.email, OWNER.password)
    await uiLogin(pageB, projectId, peerEmail, 'hunter22!')
    await Promise.all([selectEvent(pageA, chapterTitle), selectEvent(pageB, chapterTitle)])
    // Ждём, пока серверный документ комнаты получит засев от клиентов.
    await pageA.waitForTimeout(2000)

    // Оба печатают в одном поле: правки уходят по сокету, REST-записи быть не должно.
    const bodyField = '.ed-form textarea'
    await pageA.click(bodyField)
    await pageA.keyboard.press('Home')
    await pageB.click(bodyField)
    await pageB.keyboard.press('End')
    await Promise.all([
      pageA.type(bodyField, 'Аня: ', { delay: 60 }),
      pageB.type(bodyField, ' (правка Бориса)', { delay: 60 }),
    ])
    await pageA.waitForTimeout(1500)

    ok('клиенты не пишут снапшот по REST, пока сокет открыт', clientPuts.length === 0, clientPuts.join(', ') || 'ни одного PUT')

    // Сервер сохраняет сам: ждём появления обеих правок в снапшоте базы.
    let merged = ''
    let revision = before.revision
    for (let i = 0; i < 24; i += 1) {
      await pageA.waitForTimeout(500)
      const snap = await snapshot(ownerToken, projectId)
      merged = bodyFromSnapshot(snap.state, eventId)
      revision = snap.revision
      if (merged.includes('Аня:') && merged.includes('(правка Бориса)')) break
    }
    ok(
      'сервер сохранил снапшот с правками обоих авторов',
      merged.includes('Аня: ') && merged.includes(' (правка Бориса)') && merged.includes(original),
      JSON.stringify(merged),
    )
    ok('ревизия снапшота выросла (писала серверная сторона)', revision > before.revision, `${before.revision} → ${revision}`)

    // Уход последнего клиента заставляет сервер записать снапшот сразу.
    const beforeLeave = await snapshot(ownerToken, projectId)
    await pageB.type(bodyField, ' ещё раз', { delay: 40 })
    await pageA.waitForTimeout(600)
    await ctxB.close()
    let afterLeave = beforeLeave
    let late = ''
    for (let i = 0; i < 16; i += 1) {
      await pageA.waitForTimeout(500)
      afterLeave = await snapshot(ownerToken, projectId)
      late = bodyFromSnapshot(afterLeave.state, eventId)
      if (late.includes('ещё раз')) break
    }
    ok(
      'правка перед уходом участника доехала до базы без REST-записи из браузера',
      late.includes('ещё раз') && afterLeave.revision > beforeLeave.revision,
      `ревизия ${beforeLeave.revision} → ${afterLeave.revision}`,
    )
    ok('после ухода второго клиента браузеры по-прежнему ничего не писали', clientPuts.length === 0, clientPuts.join(', ') || 'ни одного PUT')
  } finally {
    await ctxA.close()
    await ctxB.close()
    await browser.close()
    await api(ownerToken, 'DELETE', `/api/projects/${projectId}`)
  }

  if (pageErrors.length) {
    problems.push(...pageErrors.map((e) => `ошибка страницы: ${e}`))
    for (const e of pageErrors) console.log(`  FAIL ошибка страницы — ${e}`)
  }

  console.log('\n=== СЕРВЕРНЫЙ ПИСАТЕЛЬ (ФАЗА 3) ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${checks}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
