// Realtime Фазы 0 (docs/realtime-editor.md): то, что нельзя проверить юнит-тестом —
// поведение двух вкладок, обрыв соединения и устаревшая ревизия снапшота.
//
// Проверяется на живом стенде:
//   1. 0.1 — после принудительного обрыва сокета клиент сам поднимает новый и правки
//      снова доезжают до второй вкладки ЧЕРЕЗ СЕРВЕР (без перезагрузки страницы);
//   2. 0.3 — вкладка без realtime (её сокет закрыт) всё равно передаёт правку второй
//      вкладке того же браузера: значит работает BroadcastChannel, а не сервер;
//   3. 0.5 — проекция дерева уходит с базовой ревизией и доезжает даже от клиента
//      без WebSocket (иначе правки живут только в CRDT, а лента/экспорт их не видят);
//   4. 0.4/0.5 — чужой снапшот записан за спиной вкладки: проекция получает 409,
//      перечитывает состояние, сливает и повторяет — правка обязана оказаться в БД.
//
// Запуск: npx tsx tests/realtime-phase0.ts   (нужен поднятый docker compose)

import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const USER = { email: process.env.AUDIT_EMAIL ?? 'galactic.test@e.com', password: process.env.AUDIT_PASS ?? 'hunter22!' }

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

interface Api {
  status: number
  json: unknown
  headers: Headers
}

async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Api> {
  const init: RequestInit = {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body instanceof Uint8Array ? {} : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  }
  if (body !== undefined) {
    // Uint8Array — тело снапшота: у fetch тип уже, чем «любые бинарные данные».
    init.body = body instanceof Uint8Array ? (body as unknown as BodyInit) : JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* не JSON — не нужен */
  }
  return { status: res.status, json, headers: res.headers }
}

/** Плоский список событий проекта: сервер отдаёт ВЛОЖЕННУЮ структуру. */
async function dbTree(token: string, projectId: string) {
  interface Row {
    id: string
    title: string
    parent_id?: string | null
    depth: number
    children?: Row[]
  }
  const res = await api(token, 'GET', `/api/projects/${projectId}/events`)
  const out: Row[] = []
  const walk = (rows: Row[]) => {
    for (const row of rows) {
      out.push(row)
      if (row.children?.length) walk(row.children)
    }
  }
  walk((res.json ?? []) as Row[])
  return out
}

async function uiLogin(page: Page, projectId: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', USER.email)
  await page.fill('input[type=password]', USER.password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 25000 })
  await page.goto(`${BASE}/projects/${projectId}`)
}

/** Первая глава появляется в пустом проекте отдельной кнопкой. */
async function seedChapter(page: Page, title: string) {
  await page.waitForSelector('button:has-text("+ Добавить первую главу")', { timeout: 30000 })
  await page.click('button:has-text("+ Добавить первую главу")')
  await page.waitForTimeout(1200)
  await page.fill('.ed-form input[placeholder="Заголовок события"]', title)
  await page.waitForTimeout(1500)
}

async function main() {
  const login = await api(null, 'POST', '/api/auth/login', USER)
  const token = (login.json as { tokens?: { access?: string } } | null)?.tokens?.access
  if (!token) throw new Error(`login: ${login.status}`)

  const created = await api(token, 'POST', '/api/projects', {
    title: `Realtime Фаза 0 ${Date.now()}`,
    description: 'Одноразовый проект для проверки realtime-Фазы 0',
  })
  const projectId = (created.json as { id?: string } | null)?.id
  if (!projectId) throw new Error(`проект не создан: ${created.status}`)

  const browser: Browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const pageErrors: string[] = []

  try {
    // ── вкладка A: сокет рвётся сразу после открытия и больше не восстанавливается
    // (прокси без Upgrade, закрытый WebSocket). Проверяем, что realtime не нужен
    // ни для проекции дерева, ни для передачи правки соседней вкладке.
    const tabA = await ctx.newPage()
    tabA.on('pageerror', (e) => pageErrors.push(`A: ${e.message}`))
    await tabA.routeWebSocket(/collab/, (ws) => {
      ws.close()
    })

    await uiLogin(tabA, projectId)
    const chapter = `Глава без сокета ${Date.now()}`
    await seedChapter(tabA, chapter)

    let tree = await dbTree(token, projectId)
    ok(
      '0.5: проекция дерева работает и без WebSocket',
      tree.some((r) => r.title === chapter),
      `в БД ${tree.length}: ${tree.map((r) => r.title).join(' | ')}`,
    )

    // ── вкладка B: обычная, в том же контексте (общий BroadcastChannel)
    const tabB = await ctx.newPage()
    tabB.on('pageerror', (e) => pageErrors.push(`B: ${e.message}`))
    await tabB.goto(`${BASE}/projects/${projectId}`)
    await tabB.waitForSelector('.ed-form input[placeholder="Заголовок события"]', { timeout: 30000 })
    await tabB.waitForTimeout(1000)

    const viaChannel = `Через канал ${Date.now()}`
    await tabA.fill('.ed-form input[placeholder="Заголовок события"]', viaChannel)
    let seenInB = true
    try {
      await tabB.waitForFunction((t) => document.body.innerText.includes(t), viaChannel, { timeout: 8000 })
    } catch {
      seenInB = false
    }
    ok('0.3: вкладка B получила правку вкладки A без сервера (BroadcastChannel)', seenInB, viaChannel)

    // ── устаревшая ревизия: снапшот записан другим клиентом за спиной вкладки
    const state = await api(token, 'GET', `/api/projects/${projectId}/events/state`)
    const revision = Number(state.headers.get('X-Skyfraze-Revision') ?? '0')
    const bump = await api(token, 'PUT', `/api/projects/${projectId}/events/state`, new Uint8Array([0, 0]), {
      'Content-Type': 'application/octet-stream',
      'X-Skyfraze-Base-Revision': String(revision),
    })
    ok(
      'подготовка: снапшот записан другим клиентом (ревизия уехала вперёд)',
      bump.status === 204,
      `было ${revision}, ответ ${bump.status}, стало ${bump.headers.get('X-Skyfraze-Revision')}`,
    )
    await tabA.waitForTimeout(400)

    // Редактируем во вкладке с устаревшей базой: проекция обязана получить 409,
    // перечитать состояние, смержить и повторить — правка не теряется.
    await tabA.click('.ed-toolbar button:has-text("+ подсобытие")')
    await tabA.waitForTimeout(700)
    const sub = `Подсобытие 409 ${Date.now()}`
    await tabA.fill('.ed-form input[placeholder="Заголовок события"]', sub)

    // Проекцию в таблицу событий пишет либо клиент без realtime (эта вкладка —
    // как раз такая: сокет у неё закрыт), либо сервер из своего документа, и
    // делает это не мгновенно. Ждём появления строки, а не читаем базу сразу.
    let subRow: { id: string; title: string; parent_id?: string | null } | undefined
    for (let i = 0; i < 24; i += 1) {
      tree = await dbTree(token, projectId)
      subRow = tree.find((r) => r.title === sub)
      if (subRow) break
      await tabA.waitForTimeout(500)
    }
    ok(
      '0.4/0.5: устаревшая база → 409 → merge → повтор, правка в БД',
      Boolean(subRow) && subRow?.parent_id === tree.find((r) => r.title === viaChannel)?.id,
      subRow ? `parent_id=${subRow.parent_id}` : tree.map((r) => r.title).join(' | '),
    )

    // ── 0.1: обрыв сокета. Рвём ТОЛЬКО первое соединение вкладки C: клиент должен
    // поднять новое сам, и правки после этого снова должны ехать через сервер.
    const tabC = await ctx.newPage()
    tabC.on('pageerror', (e) => pageErrors.push(`C: ${e.message}`))
    const connections: number[] = []
    let killed = false
    await tabC.routeWebSocket(/collab/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((m) => server.send(m))
      server.onMessage((m) => ws.send(m))
      connections.push(Date.now())
      if (!killed) {
        killed = true
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* уже закрыт */
          }
        }, 1200)
      }
    })
    await tabC.goto(`${BASE}/projects/${projectId}`)
    await tabC.waitForTimeout(5000)
    ok('0.1: после обрыва клиент поднял новое соединение', connections.length >= 2, `соединений: ${connections.length}`)

    const afterReconnect = `После обрыва ${Date.now()}`
    await tabC.fill('.ed-form input[placeholder="Заголовок события"]', afterReconnect)
    let relayed = true
    try {
      await tabB.waitForFunction((t) => document.body.innerText.includes(t), afterReconnect, { timeout: 10000 })
    } catch {
      relayed = false
    }
    ok('0.1: после реконнекта правки снова доезжают до второй вкладки через сервер', relayed, afterReconnect)
  } finally {
    await ctx.close()
    await browser.close()
    await api(token, 'DELETE', `/api/projects/${projectId}`)
  }

  if (pageErrors.length) {
    problems.push(...pageErrors.map((e) => `ошибка страницы: ${e}`))
    for (const e of pageErrors) console.log(`  FAIL ошибка страницы — ${e}`)
  }

  console.log('\n=== REALTIME ФАЗА 0 ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${checks}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
