// Проверка соавторства: поиск по нику, заявка и согласие, специализации,
// доступ к закрытому проекту только на чтение и добавление участника из круга.
//
// Запуск: npx tsx tests/coauthors.ts        (стенд: http://localhost)
import { chromium, request, type APIRequestContext } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = 'C:/Projects/SkyFraze/_coauthor_shots'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'galactic.test@e.com'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'hunter22!'
const PASS = 'hunter22!'
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

const stamp = Date.now()
const aliceEmail = `coauthor.alice.${stamp}@e.com`
const bobEmail = `coauthor.bob.${stamp}@e.com`

const api = await request.newContext()

async function login(email: string, password = PASS): Promise<string> {
  const res = await api.post(`${BASE}/api/auth/login`, { data: { email, password } })
  if (!res.ok()) throw new Error(`login ${email}: ${res.status()}`)
  const json = (await res.json()) as { tokens: { access: string } }
  return json.tokens.access
}

/** Заводит пользователя на любой инсталляции: прямая регистрация, а в режиме
 *  «по заявке» — заявка и одобрение администратором. */
async function ensureUser(email: string, displayName: string): Promise<string> {
  const reg = await api.post(`${BASE}/api/auth/register`, {
    data: { email, password: PASS, display_name: displayName },
  })
  if (reg.status() === 201) {
    return ((await reg.json()) as { tokens: { access: string } }).tokens.access
  }
  const req = await api.post(`${BASE}/api/auth/registration-requests`, {
    data: { email, password: PASS, display_name: displayName, message: 'проверка соавторства' },
  })
  if (req.status() !== 202 && req.status() !== 409) {
    throw new Error(`registration request: ${req.status()}`)
  }
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASS)
  const list = await api.get(`${BASE}/api/admin/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const found = ((await list.json()) as { requests?: Array<{ id: string; email: string }> }).requests ?? []
  const target = found.find((r) => r.email === email)
  if (!target) throw new Error(`заявка ${email} не найдена в админке`)
  const approved = await api.post(`${BASE}/api/admin/registrations/${target.id}/approve`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  if (!approved.ok()) throw new Error(`approve ${email}: ${approved.status()}`)
  return await login(email)
}

const aliceToken = await ensureUser(aliceEmail, 'Алиса Соавторова')
const bobToken = await ensureUser(bobEmail, 'Борис Иллюстратор')
const alice = { Authorization: `Bearer ${aliceToken}` }
const bob = { Authorization: `Bearer ${bobToken}` }

// Ники подбираются из email при регистрации.
const aliceMe = (await (await api.get(`${BASE}/api/auth/me`, { headers: alice })).json()) as {
  id: string
  username: string
}
const bobMe = (await (await api.get(`${BASE}/api/auth/me`, { headers: bob })).json()) as {
  id: string
  username: string
}
ok('ник подобрался при регистрации', aliceMe.username.startsWith('coauthor.alice'), aliceMe.username)
ok('ник второго пользователя тоже есть', bobMe.username.startsWith('coauthor.bob'), bobMe.username)

// Закрытый проект Алисы — именно его должен увидеть соавтор.
const created = await api.post(`${BASE}/api/projects`, {
  headers: alice,
  data: { title: `Закрытый роман ${stamp}`, description: 'черновик, доступен только кругу' },
})
const projectId = ((await created.json()) as { id: string }).id
const chapter = crypto.randomUUID()
await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
  headers: alice,
  data: [{ id: chapter, parent_id: null, position: 0, title: 'Глава первая', body: 'Текст главы.' }],
})

// До соавторства закрытый проект Борису недоступен.
const beforeAccess = await api.get(`${BASE}/api/projects/${projectId}`, { headers: bob })
ok('до соавторства проект закрыт', beforeAccess.status() === 403, `статус ${beforeAccess.status()}`)

// ── поиск по нику
const search = await api.get(`${BASE}/api/users/search?q=${bobMe.username.slice(0, 12)}`, { headers: alice })
const found = (await search.json()) as Array<{ id: string; username: string; relation: string }>
ok('поиск по нику находит человека', found.some((u) => u.id === bobMe.id), JSON.stringify(found))
ok('у найденного нет отношений', found.find((u) => u.id === bobMe.id)?.relation === '')

const shortQuery = await api.get(`${BASE}/api/users/search?q=a`, { headers: alice })
ok('слишком короткий запрос ничего не ищет', ((await shortQuery.json()) as unknown[]).length === 0)

// ── заявка и согласие
const invite = await api.post(`${BASE}/api/coauthors`, {
  headers: alice,
  data: {
    user_id: bobMe.id,
    message: 'Нужен человек на правописание и арт',
    crafts: ['Правописание и корректура', 'Иллюстрации и арт'],
  },
})
ok('заявка создана', invite.status() === 201, `статус ${invite.status()}`)
const link = (await invite.json()) as { id: string; status: string }
ok('заявка ждёт решения', link.status === 'pending', link.status)

const selfInvite = await api.post(`${BASE}/api/coauthors`, { headers: alice, data: { user_id: aliceMe.id } })
ok('себя позвать нельзя', selfInvite.status() === 400, `статус ${selfInvite.status()}`)

const bobList = (await (await api.get(`${BASE}/api/coauthors`, { headers: bob })).json()) as {
  incoming: Array<{ id: string; crafts: string[]; message: string }>
}
ok('заявка видна приглашённому', bobList.incoming.length === 1, JSON.stringify(bobList.incoming))
ok('специализации приехали с заявкой', (bobList.incoming[0]?.crafts ?? []).length === 2)

// Алиса не может принять собственную заявку — решает только приглашённый.
const wrongDecide = await api.post(`${BASE}/api/coauthors/${link.id}/accept`, { headers: alice })
ok('приглашающий не принимает свою заявку', wrongDecide.status() === 404, `статус ${wrongDecide.status()}`)

const accepted = await api.post(`${BASE}/api/coauthors/${link.id}/accept`, { headers: bob })
ok('заявка принята', accepted.ok(), `статус ${accepted.status()}`)

// ── доступ к закрытым проектам: без переключателя его нет
const stillClosed = await api.get(`${BASE}/api/projects/${projectId}`, { headers: bob })
ok('соавторство без разрешения не открывает проект', stillClosed.status() === 403, `статус ${stillClosed.status()}`)

const share = await api.patch(`${BASE}/api/coauthors/${link.id}`, {
  headers: alice,
  data: { shares_closed: true },
})
ok('владелец открыл свои закрытые проекты', share.ok(), `статус ${share.status()}`)

const opened = await api.get(`${BASE}/api/projects/${projectId}`, { headers: bob })
const openedBody = (await opened.json()) as { role?: string; coauthor_access?: boolean; title?: string }
ok('соавтор читает закрытый проект', opened.ok(), `статус ${opened.status()}`)
ok('роль — только чтение', openedBody.role === 'viewer' && openedBody.coauthor_access === true, JSON.stringify(openedBody))

// Чтение работает, запись — нет.
const readEvents = await api.get(`${BASE}/api/projects/${projectId}/events`, { headers: bob })
ok('события читаются', readEvents.ok(), `статус ${readEvents.status()}`)
const write = await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
  headers: bob,
  data: [{ id: crypto.randomUUID(), parent_id: null, position: 0, title: 'Правка соавтора', body: '' }],
})
ok('соавтор не может править дерево', write.status() === 403, `статус ${write.status()}`)

const sharedList = (await (await api.get(`${BASE}/api/projects`, { headers: bob })).json()) as Array<{
  id: string
  access: string
}>
ok(
  'проект виден в списке как соавторский',
  sharedList.some((p) => p.id === projectId && p.access === 'coauthor'),
  JSON.stringify(sharedList.filter((p) => p.id === projectId)),
)

// ── специализации правятся и видны с обеих сторон
const craftsUpdate = await api.patch(`${BASE}/api/coauthors/${link.id}`, {
  headers: alice,
  data: { crafts: ['Правописание и корректура', 'Ландшафты и мир', 'своя: карта подземелий'] },
})
ok('специализации обновились', craftsUpdate.ok(), `статус ${craftsUpdate.status()}`)
const bobCoauthors = (await (await api.get(`${BASE}/api/coauthors`, { headers: bob })).json()) as {
  coauthors: Array<{ crafts: string[] }>
}
ok(
  'вторая сторона видит специализации',
  (bobCoauthors.coauthors[0]?.crafts ?? []).includes('Ландшафты и мир'),
  JSON.stringify(bobCoauthors.coauthors),
)

// ── добавление в проект из круга (то, ради чего список и нужен)
const addMember = await api.post(`${BASE}/api/projects/${projectId}/members`, {
  headers: alice,
  data: { user_id: bobMe.id, role: 'editor' },
})
ok('соавтор добавлен в проект редактором', addMember.status() === 201, `статус ${addMember.status()}`)
const afterAdd = await api.put(`${BASE}/api/projects/${projectId}/events/tree`, {
  headers: bob,
  data: [{ id: chapter, parent_id: null, position: 0, title: 'Глава первая', body: 'Правка редактора.' }],
})
ok('после добавления правки разрешены', afterAdd.ok(), `статус ${afterAdd.status()}`)

const sharedAfterAdd = (await (await api.get(`${BASE}/api/projects`, { headers: bob })).json()) as Array<{
  id: string
  access: string
}>
ok(
  'проект-участие больше не числится соавторским',
  !sharedAfterAdd.some((p) => p.id === projectId && p.access === 'coauthor'),
  JSON.stringify(sharedAfterAdd.filter((p) => p.id === projectId)),
)

// ── интерфейс: поиск, заявка и список соавторов на странице
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
const page = await ctx.newPage()
const consoleErrors: string[] = []
const forbidden: string[] = []
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push('console: ' + m.text().slice(0, 140))
})
// Отдельно собираем отказы по правам: у читателя не должно быть запросов,
// которые бэкенд обязан отклонить, — это шум в консоли и лишний трафик.
page.on('response', (r) => {
  if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url().replace(BASE, '')}`)
})

async function loginUI(email: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', PASS)
  await page.click('button[type="submit"]')
  await page.waitForURL(/projects/, { timeout: 25000 })
}

await loginUI(aliceEmail)
await page.goto(`${BASE}/coauthors`)
await page.waitForSelector('[data-profile]', { timeout: 20000 })
ok('страница соавторов открылась', true)
const nickShown = await page.locator('[data-profile]').innerText()
ok('свой ник виден', nickShown.includes(aliceMe.username), nickShown.slice(0, 80))

await page.fill('input[aria-label="Поиск людей по нику или имени"]', bobMe.username.slice(0, 12))
await page.waitForSelector('[data-search-results]', { timeout: 15000 })
const results = await page.locator('[data-search-results]').innerText()
ok('в интерфейсе поиск находит человека', results.includes('Борис Иллюстратор'), results.slice(0, 120))
await page.screenshot({ path: `${OUT}/search.png` })

const coauthorRow = await page.locator('[data-coauthors]').innerText()
ok('соавтор есть в списке', coauthorRow.includes('Борис Иллюстратор'), coauthorRow.slice(0, 120))
ok('специализации видны чипами', coauthorRow.includes('Ландшафты и мир'), coauthorRow.slice(0, 160))
const shareBox = page.locator('[data-coauthors] input[type=checkbox]').first()
ok('переключатель доступа включён', await shareBox.isChecked())
await page.screenshot({ path: `${OUT}/coauthors-page.png` })

// Участник проекта: у Боба роль редактора, а не соавторское чтение.
await page.goto(`${BASE}/projects/${projectId}`)
await page.waitForSelector('.sf-root', { timeout: 25000 })
const readOnly = await page.locator('[data-readonly-banner]').count()
ok('редактору баннер «только чтение» не показывается', readOnly === 0)

// ── закрытое чтение в интерфейсе: снимаем участие и оставляем только круг
await api.delete(`${BASE}/api/projects/${projectId}/members/${bobMe.id}`, { headers: alice })
await loginUI(bobEmail)
await page.goto(`${BASE}/projects`)
await page.waitForSelector('[data-shared-projects]', { timeout: 20000 })
const sharedBlock = await page.locator('[data-shared-projects]').innerText()
ok('блок «Проекты соавторов» виден', sharedBlock.includes('только чтение'), sharedBlock.slice(0, 120))
ok('проект Алисы в блоке', sharedBlock.includes(`Закрытый роман ${stamp}`), sharedBlock.slice(0, 160))
await page.screenshot({ path: `${OUT}/shared-projects.png` })

await page.locator(`[data-shared-projects] a[href="/projects/${projectId}"]`).first().click()
await page.waitForSelector('.sf-root', { timeout: 25000 })
const banner = await page.locator('[data-readonly-banner]').innerText()
ok('соавтору показано «только чтение»', /только чтение/.test(banner), banner)
ok('редакторов у соавтора нет', (await page.locator('[data-editor-panel]').count()) === 0)
const editorsButton = await page.locator('.sf-topbar__actions button:has-text("Редакторы")').count()
ok('кнопки «Редакторы» у соавтора нет', editorsButton === 0)
await page.screenshot({ path: `${OUT}/readonly-project.png` })

// Поиск по нику прямо в настройках проекта: добавляем человека одной кнопкой.
await loginUI(aliceEmail)
await page.goto(`${BASE}/projects/${projectId}/settings`)
await page.waitForSelector('[data-coauthor-picker]', { timeout: 20000 })
await page.fill('[data-coauthor-picker] input[aria-label="Поиск людей по нику"]', bobMe.username.slice(0, 12))
await page.waitForSelector('[data-picker-results]', { timeout: 15000 })
const [addResponse] = await Promise.all([
  page
    .waitForResponse(
      (r) => r.url().includes('/members') && r.request().method() === 'POST',
      { timeout: 15000 },
    )
    .catch(() => null),
  page.click('[data-picker-results] button:has-text("Добавить в проект")'),
])
ok('запрос на добавление участника отправлен', addResponse?.status() === 201, `статус ${addResponse?.status()}`)
await page.waitForTimeout(1000)
const membersText = await page.locator('.card', { hasText: 'Участники' }).first().innerText()
ok('человек добавлен в участники из поиска', membersText.includes('Борис Иллюстратор'), membersText.slice(0, 200))
await page.screenshot({ path: `${OUT}/project-members.png` })

ok(
  'нет отказов по правам у читателя',
  forbidden.length === 0,
  forbidden.slice(0, 4).join(' | '),
)
ok('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await browser.close()
await api.delete(`${BASE}/api/projects/${projectId}`, { headers: alice })
await api.dispose()

console.log(`\nпроверок: ${notes.length}, ошибок: ${problems.length}`)
for (const p of problems) console.log(`  ! ${p}`)
process.exit(problems.length ? 1 : 0)
