/**
 * Живая проверка 0.77.0 на локально поднятом стенде (в CI не гоняется).
 *
 * Что проверяет — то, что нельзя проверить юнит-тестами:
 *   1. регистрация/вход и создание проекта работают на живой базе;
 *   2. эго-граф рисует РЁБРА (долг с 0.75.0: связей в данных не было, и картинку с линиями
 *      никто не видел);
 *   3. «Связать» в карточке заводит связь через интерфейс (0.76.0);
 *   4. блок предложений карточек помощника (0.77.0) смонтирован в окне помощника;
 *   5. шапка не уезжает, на телефоне нет горизонтального скролла, ошибок в консоли нет.
 *
 * Данные готовятся ЧЕРЕЗ API (Playwright request), а не `page.evaluate`: tsx добавляет в
 * вычисляемые функции обёртку `__name`, которой в браузере нет, и любой `const f = () => {}`
 * внутри evaluate падает с «__name is not defined». Из-за этого же не сеялись данные в
 * tests/visual-graph.ts.
 *
 * Запуск (backend :8181 и vite :5173 подняты):
 *   cd frontend && npx tsx tests/dev-check-077.ts
 */
import { chromium, request as playwrightRequest, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const OUT = process.env.OUT_DIR ?? '..\\_dev_shots'

interface Report {
  steps: string[]
  problems: string[]
  numbers: Record<string, unknown>
}

const report: Report = { steps: [], problems: [], numbers: {} }

function step(text: string) {
  report.steps.push(text)
  console.log(`— ${text}`)
}

function problem(text: string) {
  report.problems.push(text)
  console.warn(`  ! ${text}`)
}

async function main() {
  const api = await playwrightRequest.newContext({ baseURL: BASE })
  const token = await signInApi(api)

  // Проект: один на прогон, берётся из списка, если уже создан.
  const projectId = await ensureProjectApi(api, token)
  step(`проект: ${projectId}`)
  const seeded = await seedApi(api, token, projectId)
  step(`данные: ${JSON.stringify(seeded)}`)

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

  await signInUi(page)
  await page.goto(`${BASE}/projects/${projectId}`)
  // С 0.83.0 у владельца проект — вкладки: «Редакторы» и «Связи» показываются по одной.
  // Полоса вкладок появляется асинхронно (проект догружается), поэтому сначала ждём её.
  const tabs = page.locator('[data-project-tab="editors"]')
  await tabs.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined)
  if ((await tabs.count()) > 0) {
    await tabs.click()
    await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 45_000 })
  } else {
    // В пустом проекте панели «Редакторы» нет: она рисуется только там, где уже есть кадры.
    await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 45_000 })
  }
  await page.waitForTimeout(1800)

  await openEntities(page)
  await checkGraph(page, 'desktop')
  await checkLinkForm(page)
  await screenshot(page, 'desktop')
  await checkMatrixAndMentions(page)
  await checkNodeCard(page)
  await checkMobile(page)
  await checkAssistant(page)
  await checkHeaderStays(page)

  await browser.close()
  await api.dispose()

  report.numbers.consoleErrors = consoleErrors
  for (const err of consoleErrors) problem(`консоль: ${err}`)
  console.log('\n=== ИТОГ ===')
  console.log(JSON.stringify(report, null, 2))
  if (report.problems.length > 0) process.exitCode = 1
}

/** Вход через API: токен нужен для подготовки данных, до браузера. */
async function signInApi(api: Awaited<ReturnType<typeof playwrightRequest.newContext>>) {
  // Ответ входа: `{ tokens: { access, refresh, ... }, user: {...} }` — токен лежит в `tokens`,
  // а не в корне (сверено с internal/auth/handler.go, tokensResp).
  const accessOf = (body: unknown) =>
    ((body as { tokens?: { access?: string } })?.tokens?.access ?? '') as string

  // Ограничение попыток входа — 5 в минуту на адрес. Повторные прогоны в него упираются, и
  // «жди и повтори» здесь честнее, чем регистрировать заново (это даёт 409 «email already
  // registered» и падение сценария не по делу).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } })
    if (res.ok()) {
      const token = accessOf(await res.json())
      if (token) {
        step(`вход через API: ${EMAIL}`)
        return token
      }
    }
    if (res.status() === 429) {
      step('вход отложен: сервер ограничил попытки (429), жду 25 с')
      await new Promise((resolve) => setTimeout(resolve, 25_000))
      continue
    }
    if (res.status() === 401) break // такого пользователя нет — регистрируем ниже
    throw new Error(`вход через API: ${res.status()} ${await res.text()}`)
  }

  // На пустой базе пользователя ещё нет — регистрируем (первый становится администратором).
  const reg = await api.post('/api/auth/register', {
    data: { display_name: 'Dev Check', email: EMAIL, password: PASSWORD },
  })
  if (!reg.ok()) {
    throw new Error(`не удалось ни войти, ни зарегистрироваться: ${reg.status()} ${await reg.text()}`)
  }
  step(`регистрация через API: ${EMAIL}`)
  return accessOf(await reg.json())
}

async function ensureProjectApi(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  token: string,
): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` }
  const list = await api.get('/api/projects', { headers })
  // Ручка отдаёт ГОЛЫЙ массив (сверено с ответом сервера), поэтому разбираем оба вида: если
  // когда-нибудь появится обёртка, сценарий не начнёт молча создавать проект на каждый прогон.
  const body = (await list.json()) as
    | Array<{ id: string; title: string }>
    | { projects?: Array<{ id: string; title: string }> }
  const items = Array.isArray(body) ? body : (body.projects ?? [])
  const existing = items.find((item) => item.title === 'Проверка 0.77.0')
  if (existing) return existing.id
  const created = await api.post('/api/projects', {
    headers,
    data: { title: 'Проверка 0.77.0', description: 'Проект для живой проверки карточек, связей и графа.' },
  })
  const project = (await created.json()) as { id: string }
  step('проект создан через API')
  return project.id
}

/** Кадры (упоминания), карточки и связи — через API того же проекта. */
async function seedApi(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  token: string,
  projectId: string,
) {
  const headers = { Authorization: `Bearer ${token}` }
  const out: Record<string, unknown> = {}

  // Кадры — импортом Markdown: тот же путь записи, что у помощника и импорта «в место»
  // (CRDT-документ + проекция), только без модели.
  const events = await api.get(`/api/projects/${projectId}/events`, { headers })
  if (events.ok()) {
    const body = (await events.json()) as { events?: unknown[] }
    out.eventsBefore = body.events?.length ?? 0
  }
  if (out.eventsBefore === 0) {
    const md = [
      '# Пролог',
      '',
      'Аня стоит на пороге. Земля ещё спит, и Сторож не смотрит в её сторону.',
      '',
      '# Глава 2',
      '',
      'Аня уходит, и Земля остаётся одна. Письмо так и не дошло.',
      '',
    ].join('\n')
    const res = await api.post(`/api/projects/${projectId}/import/markdown`, {
      headers,
      multipart: {
        files: { name: 'story.md', mimeType: 'text/markdown', buffer: Buffer.from(md, 'utf8') },
      },
    })
    out.importStatus = res.status()
    if (!res.ok()) out.importBody = (await res.text()).slice(0, 300)
  }

  const base = `/api/projects/${projectId}/entities`
  const list = await api.get(base, { headers })
  const cards = ((await list.json()) as { entities?: Array<{ id: string; name: string }> }).entities ?? []
  out.cardsBefore = cards.length
  if (cards.length < 4) {
    const create = async (kind: string, name: string, aliases: string[]) => {
      const res = await api.post(base, { headers, data: { kind, name, aliases } })
      return ((await res.json()) as { entity: { id: string; name: string } }).entity
    }
    const anya = await create('character', 'Аня', ['Аню', 'Аней'])
    const earth = await create('place', 'Земля', [])
    const letter = await create('theme', 'Письмо', [])
    const guard = await create('character', 'Сторож', ['Сторожа'])
    const link = (from: string, to: string, label: string) =>
      api.post(`${base}/${from}/links`, { headers, data: { to, label } })
    await link(anya.id, earth.id, 'живёт на')
    await link(anya.id, letter.id, 'получает')
    await link(letter.id, guard.id, 'перехвачено')
    out.cardsCreated = 4
  }
  const links = await api.get(`${base}/links`, { headers })
  out.linksAfterSeed = ((await links.json()) as { links?: unknown[] }).links?.length ?? 0
  return out
}

async function signInUi(page: Page) {
  // Вход через интерфейс — второй вход за прогон; ограничение «5 в минуту на адрес» может его
  // отложить, и тогда ждём, а не падаем на пустом месте.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${BASE}/login`)
    await page.getByPlaceholder('email').fill(EMAIL)
    await page.getByPlaceholder('пароль').fill(PASSWORD)
    await page.getByRole('button', { name: /Войти/ }).click()
    const entered = await page
      .waitForURL(/\/projects$/, { timeout: 12_000 })
      .then(() => true)
      .catch(() => false)
    if (entered) {
      step('вход через интерфейс')
      return
    }
    step('вход через интерфейс отложен (вероятно 429), жду 25 с')
    await page.waitForTimeout(25_000)
  }
  throw new Error('не удалось войти через интерфейс за три попытки')
}

/** Блок «Связи проекта» раскрыт — иначе карточки и граф не видны. */
async function openEntities(page: Page) {
  // С 0.83.0 «Связи» — вкладка: сначала переключаем режим, потом ищем блок.
  if ((await page.locator('[data-relations]').count()) === 0) {
    const tab = page.locator('[data-project-tab="relations"]')
    if ((await tab.count()) > 0) {
      await tab.click()
      await page.locator('[data-relations]').waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(600)
    }
  }
  const block = page.locator('[data-entities]')
  if ((await block.count()) === 0) {
    problem('блок «Связи проекта» не смонтирован на странице редакторов')
    return
  }
  const open = await block.evaluate((el) => (el as HTMLDetailsElement).open)
  if (!open) {
    await block.locator('summary').click()
    await page.waitForTimeout(400)
  }
  const count = await page.locator('[data-entities-count]').innerText()
  const chips = await page.locator('[data-entity-link]').count()
  report.numbers.entitiesCount = count
  report.numbers.linkChips = chips
  step(`карточки: ${count}, чипов связей: ${chips}`)
  if (chips === 0) problem('чипов связей нет — связи не доехали до интерфейса')
}

/** Главное: граф с рёбрами. Рёбра — SVG-линии с подписями. */
async function checkGraph(page: Page, label: string) {
  const graph = page.locator('[data-entity-graph]')
  if ((await graph.count()) === 0) {
    problem(`граф не найден (${label})`)
    return
  }
  const mode = await graph.getAttribute('data-entity-graph')
  const center = await page.locator('[data-entity-graph-center]').innerText()
  const nodes = await page.locator('[data-entity-graph-node]').count()
  const edges = await page.locator('.egraph__edge').count()
  // Подписи читаем `textContent`: у SVG-элементов `innerText` не определён и даёт пустые строки.
  const edgeLabels = await page.locator('.egraph__edge-label').allTextContents()
  const listRows = await page.locator('[data-entity-graph-list] .egraph__row').count()
  report.numbers[`graph_${label}`] = { mode, center, nodes, edges, edgeLabels, listRows }
  step(
    `граф (${label}): режим ${mode}, центр «${center}», соседей ${nodes}, рёбер ${edges}` +
      (edgeLabels.length ? ` [${edgeLabels.join(' | ')}]` : ''),
  )
  if (edges === 0 && listRows === 0) problem(`граф без рёбер и без списка (${label})`)
  await graph.screenshot({ path: `${OUT}\\graph-${label}.png` })
}

/** «Связать» в карточке: завести связь только мышью и клавиатурой. */
async function checkLinkForm(page: Page) {
  const holderByName = page.locator('[data-entities] .ent__item', {
    has: page.locator('.ent__name', { hasText: 'Сторож' }),
  })
  const holder =
    (await holderByName.count()) > 0
      ? holderByName.first()
      : page.locator('[data-entities] .ent__item').first()
  const name = await holder.locator('.ent__name').first().innerText()
  const chipsBefore = await holder.locator('[data-entity-link]').count()

  // 0.102.0: действия карточки — в выпадающем меню «⋮», поэтому сначала открываем его у этой
  // карточки, и только потом ищем пункт «Связать».
  await holder.locator('[data-entity-menu]').first().click()
  await page.waitForTimeout(150)
  const addButtons = page.locator('[data-entity-link-add]')
  const total = await addButtons.count()
  report.numbers.linkButtons = total
  if (total === 0) {
    problem('пункта «Связать» в меню карточки нет')
    return
  }

  await holder.locator('[data-entity-link-add]').first().click()
  await page.waitForTimeout(300)
  if ((await page.locator('[data-entity-link-form]').count()) === 0) {
    problem(`форма «связать» не раскрылась для «${name}»`)
    return
  }
  const select = page.locator('[data-entity-link-target]')
  const options = await select.locator('option').allTextContents()
  const values = await select.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean),
  )
  if (values.length === 0) {
    problem('в выборе «с чем связать» нет ни одной карточки')
    return
  }
  const pick =
    (await select.locator('option', { hasText: 'Письмо' }).first().getAttribute('value')) ?? values[0]
  await select.selectOption(pick)
  // Подпись уникальная на прогон: повторная связь с той же подписью отсекается уникальностью в
  // базе («такая связь уже есть»), и проверка падала бы на собственном повторе.
  const label = `проверка ${new Date().toISOString().slice(11, 19)}`
  await page.fill('[data-entity-link-label]', label)
  const save = page.locator('[data-entity-link-save]')
  const disabledBefore = await save.isDisabled()
  await save.click()
  await page.waitForTimeout(1500)

  const chipsAfter = await holder.locator('[data-entity-link]').count()
  const note = await page
    .locator('[data-entities-note]')
    .innerText()
    .catch(() => '')
  const formGone = (await page.locator('[data-entity-link-form]').count()) === 0
  report.numbers.linkForm = {
    card: name,
    options: options.length,
    disabledBefore,
    chipsBefore,
    chipsAfter,
    formGone,
    note,
  }
  step(
    `«связать»: карточка «${name}», вариантов ${options.length}, было ${chipsBefore} связей, ` +
      `стало ${chipsAfter}, форма ${formGone ? 'закрылась' : 'ОСТАЛАСЬ'}, ответ: «${note}»`,
  )
  if (chipsAfter <= chipsBefore) problem(`связь не появилась у «${name}» (${chipsBefore} → ${chipsAfter})`)
  if (!formGone) problem('форма связи не закрылась после сохранения')
}

/** Матрица и упоминания: считается по проекции на сервере, поэтому проверяется на живой базе. */
async function checkMatrixAndMentions(page: Page) {
  const matrix = page.locator('[data-entity-matrix]')
  if ((await matrix.count()) === 0) {
    problem('матрицы «персонажи × главы» нет — упоминания не посчитались')
    return
  }
  const cells = await page.locator('[data-matrix-cell]').count()
  const summaries = await matrix.locator('summary').innerText()
  report.numbers.matrix = { cells, summary: summaries }
  step(`матрица: «${summaries}», клеток ${cells}`)
  if (cells === 0) problem('в матрице нет ни одной клетки-ссылки')
}

/** Карточка узла графа (0.78.0): по нажатию на «таблетку» — имя, вид, алиасы и связи. */
async function checkNodeCard(page: Page) {
  const center = page.locator('[data-entity-graph-center]')
  if ((await center.count()) === 0) {
    problem('центрального узла графа нет — карточку не на чем проверить')
    return
  }
  const name = await center.innerText()
  await center.click()
  await page.waitForTimeout(400)
  const card = page.locator('[data-entity-graph-card]')
  if ((await card.count()) === 0) {
    problem(`карточка узла не раскрылась по нажатию на «${name}»`)
    return
  }
  const text = (await card.innerText()).replace(/\s+/g, ' ').slice(0, 200)
  const links = await page.locator('[data-entity-graph-card-links] li').count()
  const aliases = await page.locator('[data-entity-graph-card-aliases]').innerText()
  report.numbers.nodeCard = { name, text, links, aliases }
  step(`карточка узла «${name}»: связей ${links}, алиасы «${aliases}»`)
  if (links === 0) problem(`в карточке узла «${name}» нет списка связей`)
  await card.screenshot({ path: `${OUT}\\node-card.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if ((await page.locator('[data-entity-graph-card]').count()) > 0) {
    problem('Escape не закрыл карточку узла')
  }
}

async function checkMobile(page: Page) {  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(900)
  const block = page.locator('[data-entities]')
  const box = await block.boundingBox()
  const docOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  report.numbers.mobile = { entitiesBox: box, docOverflowX: docOverflow }
  step(
    `моб. 390px: блок связей ${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'нет'}, ` +
      `гориз. скролл ${docOverflow}px`,
  )
  if (docOverflow > 1) problem(`горизонтальный скролл на 390px: ${docOverflow}px`)

  const graph = page.locator('[data-entity-graph]')
  if ((await graph.count()) === 0) return
  const mode = await graph.getAttribute('data-entity-graph')
  const rows = await page.locator('[data-entity-graph-list] .egraph__row').count()

  // Настоящий инвариант: узлы обязаны быть ВНУТРИ холста. Режим (канва или список) выбирается
  // по высоте, а не по ширине — на длинном телефоне канва с двумя-тремя соседями читается
  // лучше списка, и это решение, а не дефект (см. docs/entity-links.md §3.6).
  const bounds = await page.evaluate(() => {
    const canvas = document.querySelector('[data-entity-graph-canvas]')
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const nodes = Array.from(document.querySelectorAll('[data-entity-graph-center], [data-entity-graph-node]'))
    const outside = nodes
      .map((node) => {
        const r = node.getBoundingClientRect()
        return {
          name: (node as HTMLElement).innerText,
          left: Math.round(r.left - rect.left),
          right: Math.round(r.right - rect.left),
          top: Math.round(r.top - rect.top),
          bottom: Math.round(r.bottom - rect.top),
        }
      })
      .filter(
        (node) =>
          node.left < -2 ||
          node.top < -2 ||
          node.right > Math.round(rect.width) + 2 ||
          node.bottom > Math.round(rect.height) + 2,
      )
    return { canvas: { width: Math.round(rect.width), height: Math.round(rect.height) }, outside }
  })
  report.numbers.mobileGraph = { mode, rows, bounds }
  step(
    `моб. граф: режим ${mode}, холст ${bounds?.canvas.width}×${bounds?.canvas.height}, ` +
      `узлов вне холста: ${bounds?.outside.length ?? '—'}`,
  )
  if (bounds && bounds.outside.length > 0) {
    problem(
      `узлы графа вне холста на 390px: ${bounds.outside.map((node) => node.name).join(', ')}`,
    )
  }
  await graph.screenshot({ path: `${OUT}\\graph-mobile.png` })
  await page.screenshot({ path: `${OUT}\\mobile-full.png`, fullPage: false })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(600)
}

/** Окно помощника и блок предложений карточек (0.77.0). */
async function checkAssistant(page: Page) {
  const fab = page.locator('[data-assistant-fab]')
  if ((await fab.count()) === 0) {
    problem('кнопки помощника нет на странице')
    return
  }
  const cardsBefore = Number.parseInt(
    (await page.locator('.ent__item').count()).toString(),
    10,
  )
  await fab.click()
  await page.waitForTimeout(1500)
  const panel = page.locator('[data-assistant-panel]')
  const visible = await panel.isVisible()
  const block = page.locator('[data-entity-proposals]')
  const hasBlock = (await block.count()) > 0
  const assistantText = (await panel.innerText()).slice(0, 200)
  report.numbers.assistant = { visible, hasBlock, cardsBefore, assistantText }
  step(`помощник открыт: ${visible}, блок предложений карточек: ${hasBlock}`)
  if (!visible) problem('окно помощника не открылось')
  await page.screenshot({ path: `${OUT}\\assistant.png` })

  if (!hasBlock) {
    // На повторном прогоне предложение уже применено — это нормальный исход, а не дефект.
    step('ожидающих предложений карточек нет: UI-путь проверяется только на свежем предложении')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    return
  }

  const proposalText = (await block.innerText()).slice(0, 400)
  await block.screenshot({ path: `${OUT}\\proposal.png` })
  await block.locator('[data-entity-proposal-apply]').first().click()
  await page.waitForTimeout(2500)
  const done = await block.locator('[data-entity-proposal-done]').allInnerTexts()
  const cardsAfter = await page.locator('.ent__item').count()
  report.numbers.proposal = { proposalText, report: done, cardsBefore, cardsAfter }
  step(
    `предложение: «${proposalText.replace(/\s+/g, ' ').slice(0, 160)}…» → отчёт: ${JSON.stringify(done)}, ` +
      `карточек в панели ${cardsBefore} → ${cardsAfter}`,
  )
  if (done.length === 0) problem('после «Добавить карточки» нет отчёта о результате')
  if (cardsAfter <= cardsBefore) {
    problem(`панель связей не перечитала карточки (${cardsBefore} → ${cardsAfter})`)
  }
  await block.screenshot({ path: `${OUT}\\proposal-applied.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}

/** Меню не исчезает: та самая регрессия 0.72.x — шапка уезжала при переходе к редакторам. */
async function checkHeaderStays(page: Page) {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('.layout header') as HTMLElement | null
    const rect = header?.getBoundingClientRect()
    return {
      scrollY: window.scrollY,
      docScroll: document.documentElement.scrollTop,
      headerTop: rect ? Math.round(rect.top) : null,
      headerHeight: rect ? Math.round(rect.height) : null,
    }
  })
  report.numbers.header = metrics
  step(`шапка: top=${metrics.headerTop}px, высота ${metrics.headerHeight}px, scrollY=${metrics.scrollY}`)
  if (metrics.headerTop !== null && Math.abs(metrics.headerTop) > 1) {
    problem(`шапка уехала: top=${metrics.headerTop}px`)
  }
}

async function screenshot(page: Page, tag: string) {
  await page.screenshot({ path: `${OUT}\\${tag}-full.png`, fullPage: false })
  const entities = page.locator('[data-entities]')
  if ((await entities.count()) > 0) {
    await entities.screenshot({ path: `${OUT}\\${tag}-entities.png` }).catch(() => undefined)
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
