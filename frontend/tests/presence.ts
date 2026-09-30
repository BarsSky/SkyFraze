// Realtime Фаза 1: присутствие (кто в проекте, кто что правит, кто печатает).
//
// Проверяется через СЕРВЕР, а не через BroadcastChannel: два разных браузерных
// контекста (и два разных человека — владелец и приглашённый редактор). Поэтому
// здесь проверяется именно релей кадров присутствия в хабе и то, что интерфейс
// это показывает. Оба контекста должны видеть друг друга, «печатает…» должно
// появляться на время набора и гаснуть, а уход из проекта — убирать карточку,
// не дожидаясь таймаута призрака.
//
// Запуск: npx tsx tests/presence.ts   (нужен поднятый docker compose)

import { chromium, type BrowserContext, type Page } from 'playwright'
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
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
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
  return { status: res.status, json }
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

/** Ждём, пока в интерфейсе появится карточка участника с таким именем. */
async function waitPeer(page: Page, name: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForSelector(`[data-presence-peer][data-peer-name="${name}"]`, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Открыть форму события в панели редакторов (строка списка = выбор события). */
async function selectEvent(page: Page, title: string) {
  const row = page.locator(`.ed-row`, { hasText: title }).first()
  await row.click()
  await page.waitForSelector('.ed-form', { timeout: 15000 })
  await page.waitForTimeout(400)
}

async function main() {
  const login = await api(null, 'POST', '/api/auth/login', OWNER)
  const ownerToken = login.json?.tokens?.access as string
  if (!ownerToken) throw new Error(`login владельца: ${login.status}`)

  const created = await api(ownerToken, 'POST', '/api/projects', {
    title: `Присутствие ${Date.now()}`,
    description: 'Одноразовый проект для проверки присутствия',
  })
  const projectId = created.json?.id as string
  if (!projectId) throw new Error('проект не создан')

  const chapterTitle = `Глава присутствия ${Date.now()}`
  const event = await api(ownerToken, 'POST', `/api/projects/${projectId}/events`, {
    title: chapterTitle,
    body: 'Текст главы для проверки присутствия.',
  })
  ok('подготовка: проект и глава созданы', event.status === 201, `статус ${event.status}`)

  // Второй человек, а не вторая вкладка: присутствие не должно схлопывать двух
  // участников в одного, и через сервер должны ходить кадры между разными людьми.
  const peerEmail = `presence.peer.${Date.now()}@e.com`
  const peerName = 'Борис Присутствие'
  const peer = await ensureTestUser(BASE, peerEmail, peerName, OWNER)
  ok('подготовка: второй пользователь готов', peer.ok, peer.note)
  if (!peer.ok || !peer.access) throw new Error('второй пользователь не создан')

  const me = await api(peer.access, 'GET', '/api/auth/me')
  const peerId = me.json?.id as string
  const added = await api(ownerToken, 'POST', `/api/projects/${projectId}/members`, { user_id: peerId, role: 'editor' })
  ok('подготовка: второй пользователь добавлен редактором', added.status === 201, `статус ${added.status}`)

  const browser = await chromium.launch()
  const ctxOwner: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const ctxPeer: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const pageErrors: string[] = []

  try {
    const pageOwner = await ctxOwner.newPage()
    pageOwner.on('pageerror', (e) => pageErrors.push(`владелец: ${e.message}`))
    await uiLogin(pageOwner, projectId, OWNER.email, OWNER.password)
    await selectEvent(pageOwner, chapterTitle)

    const pagePeer = await ctxPeer.newPage()
    pagePeer.on('pageerror', (e) => pageErrors.push(`редактор: ${e.message}`))
    await uiLogin(pagePeer, projectId, peerEmail, 'hunter22!')
    await selectEvent(pagePeer, chapterTitle)

    // 1. Владелец видит второго участника (кадр присутствия прошёл через хаб).
    ok('владелец видит второго участника', await waitPeer(pageOwner, peerName, 20_000), peerName)

    // 2. Второй участник тоже видит владельца — релей двусторонний.
    const ownerName = (await api(ownerToken, 'GET', '/api/auth/me')).json?.display_name as string
    ok('второй участник видит владельца', await waitPeer(pagePeer, ownerName, 20_000), ownerName)

    // 3. «Печатает…»: у второго человека в панели открыта та же глава, он набирает текст.
    const bodyField = '.ed-form textarea'
    await pagePeer.click(bodyField)
    await pagePeer.type(bodyField, 'печатаю', { delay: 60 })
    let typingSeen = true
    try {
      await pageOwner.waitForSelector('[data-presence-typing]', { timeout: 8000 })
      const text = (await pageOwner.locator('[data-presence-typing]').first().innerText()).replace(/\s+/g, ' ').trim()
      typingSeen = text.includes('Борис')
      ok('владелец видит «печатает…» второго участника', typingSeen, text)
    } catch {
      typingSeen = false
      ok('владелец видит «печатает…» второго участника', false, 'индикатор не появился')
    }

    // 4. Отметка у события в панели редакторов: кто его правит.
    const marked = await pageOwner.locator(`[data-peer-editing="${peerName}"]`).count()
    ok('в панели редакторов отмечено, кто правит событие', marked > 0, `маркеров: ${marked}`)

    // 5. Набор прекратился — индикатор гаснет без перезагрузки.
    await pagePeer.waitForTimeout(3500)
    let typingGone = false
    try {
      await pageOwner.waitForSelector('[data-presence-typing]', { state: 'detached', timeout: 8000 })
      typingGone = true
    } catch {
      typingGone = (await pageOwner.locator('[data-presence-typing]').count()) === 0
    }
    ok('после паузы «печатает…» исчезает', typingGone)

    // 6. Уход из проекта убирает карточку сразу (кадр «я ушёл»), а не по таймауту.
    await pagePeer.goto('about:blank')
    let gone = false
    try {
      await pageOwner.waitForSelector(`[data-presence-peer][data-peer-name="${peerName}"]`, { state: 'detached', timeout: 10_000 })
      gone = true
    } catch {
      gone = false
    }
    ok('после ухода участник исчезает из проекта', gone)

    // 7. Присутствие — не данные проекта: в дереве событий его нет.
    const rows = await api(ownerToken, 'GET', `/api/projects/${projectId}/events`)
    const flat: any[] = []
    const walk = (list: any[]) => {
      for (const r of list ?? []) {
        flat.push(r)
        if (r.children?.length) walk(r.children)
      }
    }
    walk(rows.json ?? [])
    ok(
      'присутствие не попало в модель проекта',
      flat.length === 1 && !JSON.stringify(flat).includes('Борис'),
      `событий ${flat.length}`,
    )
  } finally {
    await ctxOwner.close()
    await ctxPeer.close()
    await browser.close()
    await api(ownerToken, 'DELETE', `/api/projects/${projectId}`)
  }

  if (pageErrors.length) {
    problems.push(...pageErrors.map((e) => `ошибка страницы: ${e}`))
    for (const e of pageErrors) console.log(`  FAIL ошибка страницы — ${e}`)
  }

  console.log('\n=== ПРИСУТСТВИЕ (ФАЗА 1) ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${checks}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
