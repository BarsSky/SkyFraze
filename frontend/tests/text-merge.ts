// Realtime Фаза 2: текст события живёт в `Y.Text`, а не в скалярной строке.
//
// Главное, что здесь проверяется, — то, ради чего фаза делалась: двое печатают
// ОДНО поле одновременно, и сохраняются обе правки. До Фазы 2 побеждал один
// (LWW на ключ `body`), и набранное вторым исчезало без следа.
//
// Заодно проверяется миграция: проект создаётся по API, то есть у него нет
// CRDT-снапшота, и первый редактор засеивает документ СТАРЫМИ строками
// `title`/`body` — ровно как импортированный проект. Дальше текст обязан стать
// `Y.Text`, старая строка остаться историей, а одновременная миграция двух
// клиентов — не удвоить текст.
//
// Запуск: npx tsx tests/text-merge.ts   (нужен поднятый docker compose)

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
  return { status: res.status, json, text }
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

/** Текст поля прямо из CRDT: так проверяем и сходимость, и вид поля. */
const crdtBody = (page: Page, eventId: string) =>
  page.evaluate((id: string) => {
    const doc = (window as any).__yjsDoc
    const map = doc.getArray('events').toArray().find((m: any) => m.get('id') === id)
    if (!map) return { body: null, legacy: null, isText: false }
    const value = map.get('body_text')
    return {
      body: value ? value.toString() : ((map.get('body') as string | undefined) ?? ''),
      legacy: (map.get('body') as string | undefined) ?? null,
      isText: Boolean(value && typeof value.insert === 'function'),
    }
  }, eventId)

/** Плоский список событий из вложенного дерева API. */
async function dbRows(token: string, projectId: string) {
  const res = await api(token, 'GET', `/api/projects/${projectId}/events`)
  interface Row {
    id: string
    title: string
    body: string
    children?: Row[]
  }
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
    title: `Текст ${Date.now()}`,
    description: 'Одноразовый проект для проверки Y.Text',
  })
  const projectId = created.json?.id as string
  if (!projectId) throw new Error('проект не создан')

  const original = 'Общее начало истории.'
  const chapterTitle = `Глава текста ${Date.now()}`
  const event = await api(ownerToken, 'POST', `/api/projects/${projectId}/events`, {
    title: chapterTitle,
    body: original,
  })
  const eventId = event.json?.id as string
  ok('подготовка: проект и глава созданы по API (CRDT-снапшота нет)', event.status === 201, `статус ${event.status}`)

  const peerEmail = `text.peer.${Date.now()}@e.com`
  const peerName = 'Борис Текст'
  const peer = await ensureTestUser(BASE, peerEmail, peerName, OWNER)
  if (!peer.ok || !peer.access) throw new Error('второй пользователь не создан: ' + peer.note)
  const me = await api(peer.access, 'GET', '/api/auth/me')
  await api(ownerToken, 'POST', `/api/projects/${projectId}/members`, { user_id: me.json?.id, role: 'editor' })

  const browser = await chromium.launch()
  const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const ctxB: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const pageErrors: string[] = []

  try {
    const pageA = await ctxA.newPage()
    pageA.on('pageerror', (e) => pageErrors.push(`владелец: ${e.message}`))
    const pageB = await ctxB.newPage()
    pageB.on('pageerror', (e) => pageErrors.push(`редактор: ${e.message}`))

    // Оба клиента входят заранее, а проект открывают ОДНОВРЕМЕННО: так проверяется
    // и обычная миграция, и гонка двух одновременных миграций одного снапшота.
    await uiLogin(pageA, projectId, OWNER.email, OWNER.password)
    await uiLogin(pageB, projectId, peerEmail, 'hunter22!')

    await Promise.all([
      pageA.goto(`${BASE}/projects/${projectId}`),
      pageB.goto(`${BASE}/projects/${projectId}`),
    ])
    await Promise.all([
      pageA.waitForSelector('.ed-panel', { timeout: 30000 }),
      pageB.waitForSelector('.ed-panel', { timeout: 30000 }),
    ])
    await Promise.all([selectEvent(pageA, chapterTitle), selectEvent(pageB, chapterTitle)])
    await pageA.waitForTimeout(1500)

    const onA = await crdtBody(pageA, eventId)
    ok('миграция: текст поля стал Y.Text', onA.isText, `isText=${onA.isText}`)
    ok('миграция: старая строка осталась историей', onA.legacy === original, String(onA.legacy))

    const onB = await crdtBody(pageB, eventId)
    ok('текст не удвоился при одновременной миграции двух клиентов', onB.body === original, JSON.stringify(onB.body))
    ok('оба клиента видят одинаковый текст', onA.body === onB.body, JSON.stringify([onA.body, onB.body]))

    // ── Штатный случай: двое печатают в РАЗНЫХ местах одного поля
    const bodyField = '.ed-form textarea'
    await pageA.click(bodyField)
    await pageA.keyboard.press('Home')
    await pageB.click(bodyField)
    await pageB.keyboard.press('End')
    await Promise.all([
      pageA.type(bodyField, 'Аня: ', { delay: 60 }),
      pageB.type(bodyField, ' (правка Бориса)', { delay: 60 }),
    ])
    await pageA.waitForTimeout(2500)

    const farA = await crdtBody(pageA, eventId)
    const farB = await crdtBody(pageB, eventId)
    ok(
      'набор в разных местах: обе правки целиком, исходный текст на месте',
      farA.body.includes('Аня: ') &&
        farA.body.includes(' (правка Бориса)') &&
        farA.body.includes(original),
      JSON.stringify(farA.body),
    )
    ok('набор в разных местах: клиенты сошлись', farA.body === farB.body, JSON.stringify([farA.body, farB.body]))

    // ── Худший случай: оба печатают в КОНЕЦ одного поля одновременно
    // Главу заводим в интерфейсе (а не по API): дерево живёт в CRDT, и событие,
    // созданное только в базе, в панели редакторов не появится.
    await pageA.click('.ed-toolbar button:has-text("+ глава")')
    await pageA.waitForTimeout(1000)
    await Promise.all([selectEvent(pageA, 'Новая глава'), selectEvent(pageB, 'Новая глава')])
    await pageA.waitForTimeout(800)
    const clashId = await pageA.evaluate(
      () => document.querySelector('.ed-form')?.closest('[data-editor-panel]')?.querySelector('.ed-row--active')?.getAttribute('data-event-id') ?? null,
    )
    const clashTitle = 'Новая глава'

    await pageA.click(bodyField)
    await pageA.keyboard.press('End')
    await pageB.click(bodyField)
    await pageB.keyboard.press('End')
    const aText = ' из Ани'
    const bText = ' из Бориса'
    await Promise.all([
      pageA.type(bodyField, aText, { delay: 70 }),
      pageB.type(bodyField, bText, { delay: 70 }),
    ])
    await pageA.waitForTimeout(2500)

    const clashA = clashId ? await crdtBody(pageA, clashId) : { body: '' }
    const clashB = clashId ? await crdtBody(pageB, clashId) : { body: '' }
    const lostA = [...aText].filter((ch) => !clashA.body.includes(ch))
    const lostB = [...bText].filter((ch) => !clashA.body.includes(ch))
    ok(
      'одновременный набор в одно место: не потерян ни один символ',
      Boolean(clashId) && lostA.length === 0 && lostB.length === 0,
      `потеряно ${JSON.stringify([...new Set([...lostA, ...lostB])])}, текст ${JSON.stringify(clashA.body)}`,
    )
    ok('одновременный набор: клиенты сошлись', clashA.body === clashB.body, JSON.stringify([clashA.body, clashB.body]))

    // ── Старый СНАПШОТ (а не засев из базы): так выглядит проект, который жил
    // до Фазы 2. Собираем снапшот со строковыми title/body прямо здесь и кладём
    // его в проект через PUT /events/state — миграция обязана сработать и здесь.
    const legacy = await api(ownerToken, 'POST', '/api/projects', {
      title: `Старый снапшот ${Date.now()}`,
      description: 'Проект со снапшотом старого формата',
    })
    const legacyId = legacy.json?.id as string
    const legacyEvent = await api(ownerToken, 'POST', `/api/projects/${legacyId}/events`, {
      title: 'Старая глава',
      body: 'Текст из старого снапшота.',
    })
    const legacyEventId = legacyEvent.json?.id as string

    const legacyDoc = new Y.Doc()
    const legacyMap = new Y.Map<unknown>()
    legacyMap.set('id', legacyEventId)
    legacyMap.set('title', 'Старая глава')
    legacyMap.set('body', 'Текст из старого снапшота.')
    legacyDoc.getArray('events').push([legacyMap])
    const legacyState = Y.encodeStateAsUpdate(legacyDoc)
    // Копия в собственный ArrayBuffer: Blob не принимает Uint8Array поверх
    // SharedArrayBuffer, а Yjs отдаёт именно такой тип.
    const legacyBytes = new Uint8Array(new ArrayBuffer(legacyState.byteLength))
    legacyBytes.set(legacyState)

    const put = await fetch(`${BASE}/api/projects/${legacyId}/events/state`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Skyfraze-Base-Revision': '0',
      },
      body: new Blob([legacyBytes]),
    })
    ok('подготовка: снапшот старого формата записан', put.status === 204, `статус ${put.status}`)

    await pageA.goto(`${BASE}/projects/${legacyId}`)
    await pageA.waitForSelector('.ed-panel', { timeout: 30000 })
    await selectEvent(pageA, 'Старая глава')
    await pageA.waitForTimeout(1500)

    const migrated = await crdtBody(pageA, legacyEventId)
    ok('старый снапшот мигрирован в Y.Text', migrated.isText, `isText=${migrated.isText}`)
    ok(
      'старый снапшот: текст и старая строка на месте',
      migrated.body === 'Текст из старого снапшота.' && migrated.legacy === 'Текст из старого снапшота.',
      JSON.stringify([migrated.body, migrated.legacy]),
    )

    // Правим в поле: правка обязана уехать и в CRDT, и в базу. Проекцию с Фазы 4
    // строит сервер и сохраняет раз в несколько секунд, поэтому ждём результат.
    await pageA.click(bodyField)
    await pageA.keyboard.press('End')
    await pageA.type(bodyField, ' Правка после миграции.', { delay: 40 })
    let migratedBody = ''
    for (let i = 0; i < 24; i += 1) {
      migratedBody = (await dbRows(ownerToken, legacyId)).find((r) => r.id === legacyEventId)?.body ?? ''
      if (migratedBody.includes('Правка после миграции.')) break
      await pageA.waitForTimeout(500)
    }
    ok('правка после миграции доехала до базы', migratedBody.includes('Правка после миграции.'), JSON.stringify(migratedBody))
    await api(ownerToken, 'DELETE', `/api/projects/${legacyId}`)

    // ── и всё это доехало до серверной модели (проекция дерева).
    // Проекцию с Фазы 4 строит сервер из своего документа и сохраняет раз в
    // несколько секунд (и сразу при уходе последнего клиента), поэтому ждём
    // результат, а не читаем базу сразу. Тело проекция обрезает по краям (`trim`),
    // а одновременный набор в одну позицию перемежает буквы (честный результат
    // CRDT) — сравниваем по символам, а не по подстроке.
    let row: (typeof dbRows extends never ? never : Awaited<ReturnType<typeof dbRows>>)[number] | undefined
    let clashRow: typeof row
    let dbLost: string[] = []
    for (let i = 0; i < 24; i += 1) {
      const rows = await dbRows(ownerToken, projectId)
      row = rows.find((r) => r.id === eventId)
      clashRow = rows.find((r) => r.title === clashTitle)
      dbLost = [...`${aText}${bText}`].filter((ch) => !(clashRow?.body ?? '').includes(ch))
      const okRow = row?.body.includes('Аня: ') && row?.body.includes(' (правка Бориса)')
      if (okRow && clashRow && dbLost.length === 0) break
      await pageA.waitForTimeout(500)
    }
    ok(
      'правки доехали до базы через проекцию дерева',
      Boolean(row) &&
        row!.body.includes('Аня: ') &&
        row!.body.includes(' (правка Бориса)') &&
        row!.body.includes(original) &&
        Boolean(clashRow) &&
        dbLost.length === 0,
      JSON.stringify([row?.body ?? null, clashRow?.body ?? null]),
    )
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

  console.log('\n=== ТЕКСТ СОБЫТИЯ (ФАЗА 2) ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${checks}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
