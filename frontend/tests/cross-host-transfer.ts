// Живая проверка переноса проекта между двумя стендами:
//   локальный http://localhost  →  развёрнутый http://192.168.13.66
//
// Механика: создаём проект на локальном стенде (глава + под-событие), открываем его
// в интерфейсе (так появляется CRDT-снапшот — фон кадра и привязки вложений),
// выгружаем архив и импортируем его на удалённом стенде временным пользователем.
// Затем всё созданное удаляется: и проект, и временный пользователь.
//
// Запуск: npx tsx tests/cross-host-transfer.ts

import { chromium, request, type APIRequestContext } from 'playwright'
import * as fs from 'fs'
import { treeBaseRevision } from './helpers/treeProjection'

const LOCAL = process.env.LOCAL_URL ?? 'http://localhost'
const REMOTE = process.env.REMOTE_URL ?? 'http://192.168.13.66'
const LOCAL_USER = { email: 'galactic.test@e.com', password: 'hunter22!' }
const TEMP_EMAIL = `transfer-check-${Date.now()}@example.com`
const TEMP_PASS = 'hunter22!'
const OUT = 'C:/Projects/SkyFraze/_transfer_shots'

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

async function login(api: APIRequestContext, base: string, email: string, password: string) {
  const res = await api.post(`${base}/api/auth/login`, { data: { email, password } })
  if (!res.ok()) throw new Error(`login ${email}@${base}: ${res.status()}`)
  return ((await res.json()) as { tokens: { access: string } }).tokens.access
}

async function main() {
  const api = await request.newContext()
  const localToken = await login(api, LOCAL, LOCAL_USER.email, LOCAL_USER.password)
  const localAuth = { Authorization: `Bearer ${localToken}` }
  const title = `Cross-host ${Date.now()}`

  // чистим возможные остатки прошлых прогонов
  const existing = (await (await api.get(`${LOCAL}/api/projects`, { headers: localAuth })).json()) as Array<{
    id: string
    title: string
  }>
  for (const p of existing.filter((p) => p.title.startsWith('Cross-host '))) {
    await api.delete(`${LOCAL}/api/projects/${p.id}`, { headers: localAuth })
  }

  // ── 1. проект на локальном стенде
  const created = await api.post(`${LOCAL}/api/projects`, {
    headers: localAuth,
    data: { title, description: 'перенос между стендами' },
  })
  ok('проект создан на локальном стенде', created.ok(), `статус ${created.status()}`)
  const localProjectId = ((await created.json()) as { id: string }).id

  const chapter = crypto.randomUUID()
  const child = crypto.randomUUID()
  // Базовая ревизия снапшота обязательна: без неё проекция дерева получает 428.
  await api.put(`${LOCAL}/api/projects/${localProjectId}/events/tree`, {
    headers: {
      ...localAuth,
      'X-Skyfraze-Base-Revision': await treeBaseRevision(api, LOCAL, localProjectId, localAuth),
    },
    data: [
      { id: chapter, parent_id: null, position: 0, title: 'Глава переезда', body: 'текст главы' },
      { id: child, parent_id: chapter, position: 1, title: 'Под-событие переезда', body: 'текст под-события' },
    ],
  })

  // ── 2. открываем проект в интерфейсе: так создаётся CRDT-снапшот
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(`${LOCAL}/login`)
  await page.fill('input[type=email]', LOCAL_USER.email)
  await page.fill('input[type=password]', LOCAL_USER.password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 20000 })
  await page.goto(`${LOCAL}/projects/${localProjectId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sf-root', { timeout: 25000 })
  await page.waitForTimeout(2500) // даём снапшоту записаться (debounce 300 мс + сеть)
  const state = (await (await api.get(`${LOCAL}/api/projects/${localProjectId}/events/state`, { headers: localAuth })).body()).length
  ok('на локальном стенде появился CRDT-снапшот', state > 0, `${state} байт`)

  // фон кадра — чтобы проверить перенос настроек, а не только текстов
  await page.evaluate(() => {
    document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(800)
  await page.click('.ed-bg .ed-chip:has-text("тон")')
  await page.waitForTimeout(300)
  await page.locator('.ed-tone').nth(2).click()
  await page.waitForTimeout(1500)
  await page.close()
  await ctx.close()
  await browser.close()

  // ── 3. экспорт архива с локального стенда
  const exportRes = await api.get(`${LOCAL}/api/projects/${localProjectId}/export`, { headers: localAuth })
  const archive = Buffer.from(await exportRes.body())
  fs.writeFileSync(`${OUT}/cross-host.skyfraze.zip`, archive)
  ok('архив выгружен', exportRes.ok() && archive.length > 500, `статус ${exportRes.status()}, ${archive.length} байт`)
  ok('экспорт сообщил счётчики', exportRes.headers()['x-skyfraze-export-events'] === '2', JSON.stringify({
    events: exportRes.headers()['x-skyfraze-export-events'],
    assets: exportRes.headers()['x-skyfraze-export-assets'],
  }))

  // ── 4. импорт на удалённом стенде временным пользователем
  const reg = await api.post(`${REMOTE}/api/auth/register`, {
    data: { email: TEMP_EMAIL, password: TEMP_PASS, display_name: 'Transfer Check' },
  })
  ok('временный пользователь зарегистрирован на удалённом стенде', reg.status() === 201, `статус ${reg.status()}`)
  if (reg.status() !== 201) {
    console.log('  (без пользователя проверить импорт нельзя — прерываю)')
    problems.push('не удалось создать временного пользователя на удалённом стенде')
    await api.dispose()
    process.exit(1)
  }
  const remoteToken = ((await reg.json()) as { tokens: { access: string } }).tokens.access
  const remoteAuth = { Authorization: `Bearer ${remoteToken}` }

  const importRes = await api.post(`${REMOTE}/api/projects/import`, {
    headers: remoteAuth,
    multipart: { file: { name: 'cross-host.skyfraze.zip', mimeType: 'application/zip', buffer: archive } },
  })
  const imported = importRes.ok()
    ? ((await importRes.json()) as { project: { id: string; title: string }; events: number; assets: number; state: boolean })
    : null
  ok('архив импортирован на удалённом стенде', !!imported, `статус ${importRes.status()}`)

  if (imported) {
    ok('заголовок проекта перенёсся', imported.project.title === title, imported.project.title)
    ok('события перенеслись', imported.events === 2, `events=${imported.events}`)
    ok('CRDT-снапшот перенёсся', imported.state === true, `state=${imported.state}`)

    const remoteId = imported.project.id
    const tree = (await (await api.get(`${REMOTE}/api/projects/${remoteId}/events`, { headers: remoteAuth })).json()) as Array<{
      title: string
      children: Array<{ title: string }>
    }>
    const root = tree.find((n) => /Глава переезда/.test(n.title))
    ok('дерево и вложенность на удалённом стенде', !!root && root.children.length === 1, JSON.stringify(tree.map((n) => n.title)))

    const remoteState = (await (await api.get(`${REMOTE}/api/projects/${remoteId}/events/state`, { headers: remoteAuth })).body()).length
    ok('снапшот на удалённом стенде не пустой', remoteState > 0, `${remoteState} байт`)

    // проект приезжает закрытым: публичность — свойство инстанции
    const meta = (await (await api.get(`${REMOTE}/api/projects/${remoteId}`, { headers: remoteAuth })).json()) as {
      is_public: boolean
      title: string
    }
    ok('импортированный проект закрыт (не публикуется сам)', meta.is_public === false, JSON.stringify(meta.is_public))

    // ── 5. уборка на удалённом стенде
    const del = await api.delete(`${REMOTE}/api/projects/${remoteId}`, { headers: remoteAuth })
    ok('импортированный проект удалён с удалённого стенда', del.status() === 204, `статус ${del.status()}`)
  }

  // ── 6. уборка на локальном стенде
  await api.delete(`${LOCAL}/api/projects/${localProjectId}`, { headers: localAuth })
  ok('демо-проект удалён с локального стенда', true)

  await api.dispose()
  console.log('\n=== ПЕРЕНОС МЕЖДУ СТЕНДАМИ ===')
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
  console.log(`временный пользователь на удалённом стенде: ${TEMP_EMAIL}`)
  process.exit(problems.length ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
