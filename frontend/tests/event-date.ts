// Дата события: связь «редактор ↔ база» через проекцию дерева.
//
// Дата — поле, которое легко «потерять молча»: она живёт в CRDT (её пишет
// `input[type=date]`), в базе (`events.event_date`) и в проекции дерева между
// ними. Проверяем все три состояния протокола проекции:
//   * дата пришла значением → записывается в базу;
//   * дата пришла пустой    → дата в базе очищается;
//   * поля нет              → дату в базе не трогаем (клиент мог её не видеть:
//     старый снапшот или импортированный проект без CRDT).
// Плюс две видимые вещи: дата из базы доезжает до первого редактора (засев CRDT
// из таблицы events) и показывается мета-чипом в кадре.
//
// Запуск: npx tsx tests/event-date.ts   (нужен поднятый docker compose)

import { chromium } from 'playwright'

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

async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
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
  return { status: res.status, json, text }
}

/** Плоский список событий: API отдаёт вложенное дерево. */
async function rows(token: string, projectId: string) {
  interface Row {
    id: string
    title: string
    event_date?: string | null
    children?: Row[]
  }
  const res = await api(token, 'GET', `/api/projects/${projectId}/events`)
  const out: Row[] = []
  const walk = (list: Row[]) => {
    for (const r of list) {
      out.push(r)
      if (r.children?.length) walk(r.children)
    }
  }
  walk((res.json ?? []) as Row[])
  return out
}

const dayOf = (value?: string | null) => (value ? value.slice(0, 10) : null)

async function main() {
  const login = await api(null, 'POST', '/api/auth/login', USER)
  const token = login.json?.tokens?.access as string
  if (!token) throw new Error(`login: ${login.status}`)

  const created = await api(token, 'POST', '/api/projects', {
    title: `Дата ${Date.now()}`,
    description: 'Одноразовый проект для проверки даты события',
  })
  const projectId = created.json?.id as string
  if (!projectId) throw new Error(`проект не создан: ${created.status}`)

  // Событие создаём по API: CRDT-снапшота у проекта нет, поэтому редактор засеет
  // документ из таблицы events — так же выглядит импортированный проект.
  const event = await api(token, 'POST', `/api/projects/${projectId}/events`, {
    title: 'Глава с датой',
    body: 'Текст главы.',
    event_date: '2024-05-17T00:00:00Z',
  })
  ok('подготовка: событие с датой создано по API', event.status === 201, `статус ${event.status}`)

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const pageErrors: string[] = []

  try {
    const page = await ctx.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(`${BASE}/login`)
    await page.fill('input[type=email]', USER.email)
    await page.fill('input[type=password]', USER.password)
    await page.click('button[type=submit]')
    await page.waitForURL(/projects/, { timeout: 25000 })
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.waitForSelector('.ed-form input[type=date]', { timeout: 30000 })
    await page.waitForTimeout(1500)

    const shown = await page.inputValue('.ed-form input[type=date]')
    ok('дата из базы видна первому редактору (засев CRDT)', shown === '2024-05-17', `поле показывает ${JSON.stringify(shown)}`)

    let chip = (await page.locator('.sf-copy__meta').allInnerTexts().catch(() => [] as string[])).join(' ').replace(/\s+/g, ' ').trim()
    ok('дата показана мета-чипом в кадре', chip.includes('17.05.2024'), chip)

    // Дата пришла значением — уезжает в базу.
    await page.fill('.ed-form input[type=date]', '2789-04-12')
    await page.waitForTimeout(2500)
    let dbRows = await rows(token, projectId)
    ok('дата из редактора доехала до базы', dayOf(dbRows[0]?.event_date) === '2789-04-12', `в базе ${dbRows[0]?.event_date}`)

    let chipUpdated = true
    try {
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('.sf-copy__meta')).some((el) => (el.textContent ?? '').includes('12.04.2789')),
        null,
        { timeout: 8000 },
      )
    } catch {
      chipUpdated = false
    }
    chip = (await page.locator('.sf-copy__meta').allInnerTexts().catch(() => [] as string[])).join(' ').replace(/\s+/g, ' ').trim()
    ok('мета-чип обновился по новой дате', chipUpdated, chip)

    // Дата пришла пустой — очищается в базе.
    await page.fill('.ed-form input[type=date]', '')
    await page.waitForTimeout(2500)
    dbRows = await rows(token, projectId)
    ok('очищенная дата убрана из базы', dayOf(dbRows[0]?.event_date) === null, `в базе ${dbRows[0]?.event_date ?? 'пусто'}`)
  } finally {
    await ctx.close()
    await browser.close()
    await api(token, 'DELETE', `/api/projects/${projectId}`)
  }

  if (pageErrors.length) {
    problems.push(...pageErrors.map((e) => `ошибка страницы: ${e}`))
    for (const e of pageErrors) console.log(`  FAIL ошибка страницы — ${e}`)
  }

  console.log('\n=== ДАТА СОБЫТИЯ ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${checks}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
