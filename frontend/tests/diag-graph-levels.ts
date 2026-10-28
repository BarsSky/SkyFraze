/**
 * Живая проверка уровней графа и поиска по меткам (0.100.0).
 *
 * Отчёт: «видно ли карточки, чьи связи не совпадают; можно ли свайпом перебирать группы; как
 * группировать карточки и ориентироваться, с акцентом на главную группу и погружением в подгруппы;
 * поиск должен выдавать подсказками совпадающие метки и открывать карточку».
 *
 * Проверяем на живом стенде: мир → группа → карточка, акцент на главной группе (созданной первой),
 * листание групп стрелками, «глубже» с уровнями окрестности и поиск по алиасу/подписи связи.
 *
 * Запуск: cd frontend && npx tsx tests/diag-graph-levels.ts
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const WIDTHS = (process.env.WIDTHS ?? '1280,360').split(',').map(Number)

const HUB = 'Аня'
const OTHERS: Array<[string, string]> = [
  ['Земля', 'живёт на'],
  ['Сторож маяка', 'боится'],
  ['Письмо из-за пролива', 'нашла письмо от'],
]

async function main() {
  const browser = await chromium.launch()
  const problems: string[] = []

  const loginContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const loginPage = await loginContext.newPage()
  await loginPage.goto(`${BASE}/login`)
  await loginPage.getByPlaceholder('email').fill(EMAIL)
  await loginPage.getByPlaceholder('пароль').fill(PASSWORD)
  await loginPage.getByRole('button', { name: /Войти/ }).click()
  await loginPage.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await loginPage.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }

  const created = await (await loginPage.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика уровней графа', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id

  try {
    // Глава нужна, чтобы появились вкладки: без содержимого их нет вовсе.
    await loginPage.goto(`${BASE}/projects/${projectId}`)
    await loginPage.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })

    const ids = new Map<string, string>()
    const cards: Array<[string, string]> = [
      [HUB, 'character'],
      ['Земля', 'place'],
      ['Сторож маяка', 'character'],
      ['Письмо из-за пролива', 'theme'],
    ]
    for (const [name, kind] of cards) {
      const response = await loginPage.request.post(`${API}/api/projects/${projectId}/entities`, {
        headers,
        data: { name, kind, aliases: name === HUB ? ['Анна'] : [] },
      })
      if (response.status() !== 201) problems.push(`карточка «${name}»: ${response.status()}`)
      const body = (await response.json()) as { entity?: { id: string } }
      if (body.entity?.id) ids.set(name, body.entity.id)
    }
    for (const [name, label] of OTHERS) {
      const response = await loginPage.request.post(
        `${API}/api/projects/${projectId}/entities/${ids.get(HUB)}/links`,
        { headers, data: { to: ids.get(name), label } },
      )
      if (response.status() !== 201) problems.push(`связь «${name}»: ${response.status()}`)
    }

    const storageState = await loginContext.storageState()
    for (const width of WIDTHS) {
      await checkWidth(browser, storageState, projectId, width, problems)
    }
  } finally {
    const removed = await loginPage.request.delete(`${API}/api/projects/${projectId}`, { headers })
    console.log(`\nуборка: проект удалён (${removed.status()})`)
    await loginContext.close()
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимки: graph-levels-<ширина>.png')
}

async function checkWidth(
  browser: Browser,
  storageState: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>,
  projectId: string,
  width: number,
  problems: string[],
) {
  const context = await browser.newContext({
    viewport: { width, height: width <= 520 ? 800 : 1000 },
    hasTouch: width <= 520,
    isMobile: width <= 520,
    storageState,
  })
  const page: Page = await context.newPage()
  await page.goto(`${BASE}/projects/${projectId}`)
  const tab = page.locator('[data-project-tab="relations"]')
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await tab.click()
  await page.locator('[data-entity-graph-canvas], [data-entity-graph="rail"], [data-entity-graph="world"]').first().waitFor({ timeout: 30_000 })
  console.log(`\n=== ${width}px`)

  // 1. Уровень «мир»: группы, главная с акцентом.
  await page.getByRole('button', { name: 'Мир' }).first().click()
  await page.locator('[data-entity-graph-groups]').waitFor({ timeout: 15_000 })
  const groups = (await page.evaluate(`(async () => {
    return [...document.querySelectorAll('[data-entity-graph-group]')].map((node) => ({
      kind: node.getAttribute('data-entity-graph-group'),
      main: node.className.includes('is-main'),
      text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
    }))
  })()`)) as Array<{ kind: string; main: boolean; text: string }>
  for (const group of groups) console.log(`группа ${group.kind}: ${group.main ? 'главная, ' : ''}${group.text}`)
  if (groups.length < 3) problems.push(`${width}px: групп ${groups.length}, ожидалось минимум 3`)
  if (groups.filter((group) => group.main).length !== 1) problems.push(`${width}px: главная группа не одна`)
  if (!groups[0]?.main) problems.push(`${width}px: главная группа не первая (первой создан «Персонаж»)`)

  // 2. Вход в группу «Персонаж»: подгруппы по подписям связей (0.101.0).
  await page.locator('[data-entity-graph-group="character"]').click()
  await page.locator('[data-entity-graph-group-cards]').waitFor({ timeout: 15_000 })
  const first = await page.locator('[data-entity-graph-group-cards]').getAttribute('data-entity-graph-group-cards')
  // Строк в подгруппах больше, чем карточек: одна карточка может стоять в нескольких подгруппах
  // (у Ани есть и «живёт на», и «боится»). Поэтому считаем УНИКАЛЬНЫЕ карточки.
  const uniqueCards = (await page.evaluate(`(async () => {
    const ids = new Set()
    for (const node of document.querySelectorAll('[data-entity-graph-group-card]')) {
      ids.add(node.getAttribute('data-entity-graph-group-card'))
    }
    return ids.size
  })()`)) as number
  console.log(`в группе «${first}» уникальных карточек: ${uniqueCards}`)
  if (uniqueCards < 2) problems.push(`${width}px: в группе персонажей ${uniqueCards} карточек вместо 2`)

  const clusters = (await page.evaluate(`(async () => {
    return [...document.querySelectorAll('[data-entity-graph-cluster]')].map((node) => ({
      label: node.getAttribute('data-entity-graph-cluster'),
      cards: node.querySelectorAll('[data-entity-graph-group-card]').length,
      text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    }))
  })()`)) as Array<{ label: string; cards: number; text: string }>
  for (const cluster of clusters) {
    console.log(`подгруппа «${cluster.label}»: карточек ${cluster.cards} — ${cluster.text}`)
  }
  if (clusters.length === 0) problems.push(`${width}px: подгрупп по подписям связей нет`)
  const firstToggle = page.locator('[data-entity-graph-cluster-toggle]').first()
  if ((await firstToggle.count()) > 0) {
    const label = await firstToggle.getAttribute('data-entity-graph-cluster-toggle')
    await firstToggle.click()
    const expandedAfter = await firstToggle.getAttribute('aria-expanded')
    console.log(`подгруппа «${label}» после нажатия: aria-expanded ${expandedAfter}`)
    if (expandedAfter !== 'false') problems.push(`${width}px: подгруппа не свернулась`)
    await firstToggle.click()
  }

  // 3. Запоминание уровня (0.101.0): после перезагрузки человек попадает в ту же группу.
  //    Проверяем ДО входа в карточку: вход в карточку честно переключает запомненный уровень на «card».
  await page.reload()
  await tab.waitFor({ state: 'visible', timeout: 30_000 })
  await tab.click()
  await page.locator('[data-entity-graph-group-cards], [data-entity-graph-canvas], [data-entity-graph="rail"]')
    .first()
    .waitFor({ timeout: 20_000 })
  const restored = await page.locator('[data-entity-graph-group-cards]').count()
  console.log(`после перезагрузки: группа ${restored > 0 ? 'восстановлена' : 'не восстановлена'}`)
  if (restored === 0) problems.push(`${width}px: уровень не запомнился — после перезагрузки открылась карточка`)

  // 3.1. Листание групп стрелками — на восстановленном уровне.
  const groupNow = await page.locator('[data-entity-graph-group-cards]').getAttribute('data-entity-graph-group-cards')
  await page.locator('[data-entity-graph-group-next]').click()
  const next = await page.locator('[data-entity-graph-group-cards]').getAttribute('data-entity-graph-group-cards')
  console.log(`после «→» группа: ${next}`)
  if (next === groupNow) problems.push(`${width}px: листание групп не переключило группу`)

  // 3.2. Открыть карточку из группы — она встаёт в центр.
  await page.locator('[data-entity-graph-group-card]').first().click()
  await page.locator('[data-entity-graph-center], [data-entity-graph-list]').first().waitFor({ timeout: 15_000 })
  const center = ((await page.locator('[data-entity-graph-center]').first().innerText().catch(() => '')) || '').trim()
  console.log(`центр графа после входа: ${center || '(список)'}`)

  // 4. Поиск по алиасу: подсказка объясняет, почему карточка в выдаче.
  const search = page.getByLabel('Поиск по карточкам в графе')
  await search.fill('Анна')
  await page.locator('[data-entity-graph-match]').first().waitFor({ timeout: 15_000 })
  const hit = (await page.evaluate(`(async () => {
    const node = document.querySelector('[data-entity-graph-match]')
    return node ? { source: node.getAttribute('data-entity-graph-match-source'), text: (node.textContent || '').replace(/\\s+/g, ' ').trim() } : null
  })()`)) as { source: string; text: string } | null
  console.log(`подсказка по «Анна»: ${hit?.text} (источник ${hit?.source})`)
  if (hit?.source !== 'alias') problems.push(`${width}px: поиск по алиасу не нашёл (${hit?.source})`)
  await page.locator('[data-entity-graph-match]').first().click()
  await page.locator('[role="dialog"]').first().waitFor({ timeout: 15_000 })
  console.log('карточка из подсказки открылась в обозревателе')
  await page.keyboard.press('Escape')

  // 5. Поиск по подписи связи.
  await search.fill('боится')
  await page.locator('[data-entity-graph-match]').first().waitFor({ timeout: 15_000 })
  const linkHit = (await page.evaluate(`(async () => {
    const node = document.querySelector('[data-entity-graph-match]')
    return node ? { source: node.getAttribute('data-entity-graph-match-source'), text: (node.textContent || '').replace(/\\s+/g, ' ').trim() } : null
  })()`)) as { source: string; text: string } | null
  console.log(`подсказка по «боится»: ${linkHit?.text} (источник ${linkHit?.source})`)
  if (linkHit?.source !== 'link') problems.push(`${width}px: поиск по подписи связи не нашёл`)
  await search.fill('')

  // 6. «Глубже»: уровни окрестности, без верхней границы.
  const deeper = page.locator('[data-entity-graph-deeper]')
  if ((await deeper.count()) > 0) {
    await deeper.first().click()
    await page.locator('[data-entity-graph-level]').first().waitFor({ timeout: 15_000 })
    const level = (await page.locator('[data-entity-graph-level]').first().innerText()).replace(/\s+/g, ' ').trim()
    console.log(`уровень окрестности: ${level}`)
    await page.locator('[data-entity-graph-flatter]').first().click()
  } else {
    console.log('«глубже» недоступно: у выбранной карточки нет окрестности глубже (это допустимо)')
  }

  const pageScroll = (await page.evaluate(`(async () => document.documentElement.scrollWidth)()`)) as number
  if (pageScroll > width + 1) problems.push(`${width}px: горизонтальная прокрутка ${pageScroll} > ${width}`)
  await page.screenshot({ path: `..\\_dev_shots\\graph-levels-${width}.png` })
  await context.close()
}

await main()
