/**
 * Живая проверка нажатий на телефоне (0.98.1).
 *
 * Отчёт: «в мобильной версии в полоске меню кнопка ещё никак не реагирует на касание». Слово «ещё»
 * означает повтор: полоса вкладок уже проверялась в 0.86.0 (`diag-tabs-overlap.ts`) — тогда искали,
 * что лежит поверх неё. Теперь проверяем ровно то, что чувствует палец: попадает ли касание в саму
 * кнопку и переключается ли вкладка после тапа.
 *
 * Проверяются ВСЕ кнопки полосы, включая «Настройки» (это ссылка, а не кнопка — именно её легко
 * пропустить) и кнопку «Ещё» в шапке, на пяти ширинах телефона.
 *
 * Запуск: cd frontend && npx tsx tests/diag-mobile-taps.ts
 * Только одна ширина: WIDTHS=320 npx tsx tests/diag-mobile-taps.ts
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const HEIGHT = Number(process.env.HEIGHT ?? 800)
/** Ширины телефонов: 320 (узкий), 360, 390, 412, 430 — на любой из них кнопки обязаны нажиматься. */
const WIDTHS = (process.env.WIDTHS ?? '320,360,390,412,430')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

const TABS: Array<{ id: string; title: string }> = [
  { id: 'project', title: 'Проект' },
  { id: 'editors', title: 'Редакторы' },
  { id: 'relations', title: 'Связи' },
  { id: 'versions', title: 'Версии' },
  { id: 'settings', title: 'Настройки' },
]

type Hit = {
  found: boolean
  inViewport: boolean
  target: string
  selfTarget: boolean
  pointerEvents: string
  insideBar: boolean
  zIndexes: string[]
}

/** Кто получит касание в центре элемента и не перекрыт ли он чем-то. */
const hitTest = async (page: Page, selector: string): Promise<Hit> =>
  (await page.evaluate(`(async () => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return { found: false, inViewport: false, target: '', selfTarget: false, pointerEvents: '', insideBar: false, zIndexes: [] }
    const box = node.getBoundingClientRect()
    const x = Math.round(box.left + box.width / 2)
    const y = Math.round(box.top + box.height / 2)
    const inViewport = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight
    const hit = document.elementFromPoint(x, y)
    const describe = (el) => el ? el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : ''
    const zIndexes = []
    let cursor = hit
    while (cursor && cursor !== document.body) {
      const style = getComputedStyle(cursor)
      if (style.zIndex !== 'auto') zIndexes.push(describe(cursor) + ' z=' + style.zIndex + ' pos=' + style.position)
      cursor = cursor.parentElement
    }
    const bar = node.closest('[data-project-tabs]')
    return {
      found: true,
      inViewport,
      target: describe(hit),
      selfTarget: hit === node || node.contains(hit),
      pointerEvents: getComputedStyle(node).pointerEvents,
      insideBar: bar ? box.top >= bar.getBoundingClientRect().top - 1 && box.bottom <= bar.getBoundingClientRect().bottom + 1 : true,
      zIndexes,
    }
  })()`)) as Hit

/** Все проверки на одной ширине: вкладки полосы, «Настройки», «Ещё» и цельность полосы. */
async function checkWidth(
  browser: Browser,
  projectId: string,
  width: number,
  problems: string[],
  storageState: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>,
): Promise<void> {
  const context = await browser.newContext({
    storageState,
    viewport: { width, height: HEIGHT },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => problems.push(`${width}px pageerror: ${error.message}`))
  console.log(`\n=== ${width}×${HEIGHT}`)

  const tabs = page.locator('[data-project-tabs]')
  await page.goto(`${BASE}/projects/${projectId}`)
  await tabs.waitFor({ state: 'visible', timeout: 30_000 })

  const headerButtons = (await page.evaluate(`(async () => {
    const bar = document.querySelector('.layout header')
    if (!bar) return []
    return [...bar.querySelectorAll('button, a')]
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24))
  })()`)) as string[]
  console.log(`кнопки шапки: ${headerButtons.join(' | ')}`)

  for (const tab of TABS) {
    const selector = `[data-project-tab="${tab.id}"]`
    if ((await page.locator(selector).count()) === 0) {
      console.log(`вкладка «${tab.title}»: нет на экране`)
      problems.push(`${width}px: вкладки «${tab.title}» нет на экране`)
      continue
    }
    const hit = await hitTest(page, selector)
    console.log(
      `вкладка «${tab.title}»: в экране ${hit.inViewport}, цель касания ${hit.selfTarget ? 'сама кнопка' : hit.target}, ` +
        `pointer-events ${hit.pointerEvents}, внутри полосы ${hit.insideBar}`,
    )
    if (!hit.inViewport) problems.push(`${width}px: вкладка «${tab.title}» за пределами экрана`)
    if (!hit.selfTarget) {
      problems.push(`${width}px: касание по «${tab.title}» попадает в «${hit.target}»`)
      for (const line of hit.zIndexes) console.log(`   над кнопкой: ${line}`)
    }
    if (hit.pointerEvents === 'none') problems.push(`${width}px: у «${tab.title}» pointer-events: none`)
    if (!hit.insideBar) problems.push(`${width}px: кнопка «${tab.title}» вышла за полосу вкладок`)

    // Настоящий тап: переключилась ли вкладка. «Настройки» — переход на страницу, у неё проверяем
    // сам адрес: это ссылка, а не вкладка панели.
    await page.locator(selector).tap({ timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(300)
    if (tab.id === 'settings') {
      const url = page.url()
      console.log(`   после тапа: адрес ${url.split('/').slice(-2).join('/')}`)
      if (!/\/settings$/.test(url)) problems.push(`${width}px: тап по «Настройки» не открыл страницу настроек`)
      await page.goto(`${BASE}/projects/${projectId}`)
      await tabs.waitFor({ state: 'visible', timeout: 30_000 })
      continue
    }
    const active = (await page.locator(selector).getAttribute('aria-selected')) === 'true'
    const panel = await page.locator('#project-tab-panel').getAttribute('aria-labelledby').catch(() => null)
    console.log(`   после тапа: активна ${active}, панель ${panel}`)
    if (!active && panel !== `project-tab-${tab.id}`) problems.push(`${width}px: тап по «${tab.title}» не переключил вкладку`)
  }

  // Кнопка «Ещё» в шапке: открывается ли меню касанием (и закрывается повторным).
  const more = page.locator('header button', { hasText: 'Ещё' }).first()
  if ((await more.count()) > 0) {
    await more.tap({ timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(300)
    // Проверяем не «есть ли узел в DOM» (у обрезанного меню тоже есть размер), а попадает ли
    // касание в его первый пункт: именно на этом 0.98.1 промахнулась — меню существовало, но было
    // обрезано шапкой, и тап уходил в страницу.
    const state = (await page.evaluate(`(async () => {
      const menu = document.querySelector('[data-header-menu]')
      if (!menu || !menu.firstElementChild) return { hit: false, where: 'меню нет' }
      const item = menu.firstElementChild.getBoundingClientRect()
      const found = document.elementFromPoint(Math.round(item.left + item.width / 2), Math.round(item.top + item.height / 2))
      return { hit: menu.contains(found), where: found ? found.tagName.toLowerCase() : 'пусто' }
    })()`)) as { hit: boolean; where: string }
    const opened = state.hit
    console.log(`кнопка «Ещё»: пункт меню под касанием — ${opened} (в точке ${state.where})`)
    if (!opened) problems.push(`${width}px: тап по «Ещё» не открыл видимое меню (в точке ${state.where})`)

    // Пункты меню: раздел (ссылка) и действие (тема). Обе — «кнопки в полоске меню».
    const navItem = page.locator('[data-header-menu] a').first()
    if ((await navItem.count()) > 0) {
      const label = ((await navItem.innerText()) || '').trim()
      const before = page.url()
      await navItem.tap({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(500)
      const moved = page.url() !== before
      console.log(`пункт меню «${label}»: перешли — ${moved}`)
      if (!moved) problems.push(`${width}px: тап по пункту меню «${label}» никуда не привёл`)
      await page.goto(`${BASE}/projects/${projectId}`)
      await tabs.waitFor({ state: 'visible', timeout: 30_000 })
      await more.tap({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(250)
    }
    const actionItem = page.locator('[data-header-menu] [data-header-action]').first()
    if ((await actionItem.count()) > 0) {
      const label = ((await actionItem.innerText()) || '').trim()
      const before = (await page.evaluate(`(async () => document.documentElement.getAttribute('data-theme'))()`)) as string
      await actionItem.tap({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(400)
      const after = (await page.evaluate(`(async () => document.documentElement.getAttribute('data-theme'))()`)) as string
      console.log(`пункт меню «${label}»: тема ${before} → ${after}`)
      if (before === after) problems.push(`${width}px: тап по пункту меню «${label}» ничего не сделал`)
    }
    await page.screenshot({ path: `..\\_dev_shots\\mobile-taps-${width}.png` })
  } else {
    console.log('кнопки «Ещё» в шапке нет')
  }

  // Колокольчик в шапке — тоже кнопка в полоске. Должен открывать панель касанием.
  const bell = page.locator('[data-notify-bell]').first()
  if ((await bell.count()) > 0) {
    await bell.tap({ timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(300)
    const state = (await page.evaluate(`(async () => {
      const node = document.querySelector('[data-notify-panel]')
      const button = document.querySelector('[data-notify-bell]')
      return {
        panel: node ? { h: Math.round(node.getBoundingClientRect().height), text: (node.innerText || '').slice(0, 40) } : null,
        expanded: button ? (button.getAttribute('aria-expanded') || 'нет') : 'нет кнопки',
      }
    })()`)) as { panel: { h: number; text: string } | null; expanded: string }
    console.log(
      `колокольчик: панель ${state.panel ? state.panel.h + ' px, «' + state.panel.text + '»' : 'нет'}, aria-expanded ${state.expanded}`,
    )
    const panel = state.panel !== null && state.panel.h > 30
    if (!panel) problems.push(`${width}px: тап по колокольчику не открыл панель`)
    // Панель над полосой вкладок — нормальное поведение выпадающего списка, но для замера самой
    // полосы её надо закрыть: иначе она честно перекроет вкладки, и проверка станет ложной.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }

  // Полоса вкладок целиком: не перекрыт ли её край чем-то посторонним.
  const bar = (await page.evaluate(`(async () => {
    const strip = document.querySelector('[data-project-tabs]')
    if (!strip) return null
    const box = strip.getBoundingClientRect()
    const blocked = []
    for (let x = box.left + 4; x < box.right; x += 20) {
      const hit = document.elementFromPoint(x, Math.round(box.top + box.height / 2))
      if (hit && !strip.contains(hit)) blocked.push(Math.round(x) + '→' + hit.tagName.toLowerCase() + '.' + (hit.className || ''))
    }
    return { top: Math.round(box.top), height: Math.round(box.height), blocked }
  })()`)) as { top: number; height: number; blocked: string[] } | null
  if (bar) {
    console.log(`полоса вкладок: y ${bar.top}, высота ${bar.height}, перекрыто точек: ${bar.blocked.length}`)
    for (const item of bar.blocked) problems.push(`${width}px: полосу вкладок перекрывает ${item}`)
  }

  // 4. Прокрученная страница: шапка и полоса закреплены, а под ними ездит содержимое. Именно в этом
  // состоянии «кнопка не реагирует», если закреплённый слой перекрывает полосу — такая регрессия уже
  // была в 0.86.0, но проверялась на других ширинах и без прокрутки.
  for (const scrollBy of [400, 1400]) {
    await page.goto(`${BASE}/projects/${projectId}`)
    await tabs.waitFor({ state: 'visible', timeout: 30_000 })
    await page.evaluate(`(async () => window.scrollTo(0, ${scrollBy}))()`)
    await page.waitForTimeout(400)
    const scrolledY = (await page.evaluate(`(async () => Math.round(window.scrollY))()`)) as number
    if (scrolledY < 10) {
      console.log(`прокрутка ${scrollBy}: страница не прокручивается — пропуск`)
      continue
    }
    for (const tab of TABS.filter((item) => item.id !== 'settings')) {
      const selector = `[data-project-tab="${tab.id}"]`
      const hit = await hitTest(page, selector)
      await page.locator(selector).tap({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(200)
      const active = (await page.locator(selector).getAttribute('aria-selected')) === 'true'
      console.log(
        `прокрутка ${scrolledY}: «${tab.title}» — цель ${hit.selfTarget ? 'сама кнопка' : hit.target}, ` +
          `стала активна ${active}`,
      )
      if (!hit.selfTarget) {
        problems.push(`${width}px, прокрутка ${scrolledY}: касание по «${tab.title}» попадает в «${hit.target}»`)
      }
      if (!active) problems.push(`${width}px, прокрутка ${scrolledY}: тап по «${tab.title}» не переключил вкладку`)
    }
  }

  // 5. Чипы кадров над сценой: это тоже полоска «меню» проекта — главы и шаги. Проверяем, что чип
  // получает касание и что он не мельче пальца.
  await page.goto(`${BASE}/projects/${projectId}`)
  await tabs.waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(900)
  const chips = page.locator('.sf-chips button')
  const chipCount = await chips.count()
  console.log(`чипов кадров: ${chipCount}`)
  if (chipCount === 0) {
    console.log('чипов нет — проверка чипов пропущена')
  } else {
    for (let index = 0; index < Math.min(chipCount, 3); index += 1) {
      const chip = chips.nth(index)
      const label = ((await chip.innerText()) || '').replace(/\s+/g, ' ').trim().slice(0, 24)
      const box = await chip.boundingBox()
      if (box === null) continue
      const hit = (await page.evaluate(`(async () => {
        const node = document.querySelectorAll('.sf-chips button')[${index}]
        if (!node) return { selfTarget: false, target: 'нет узла' }
        const rect = node.getBoundingClientRect()
        const found = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
        const describe = (el) => el ? el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).join('.') : '') : ''
        return { selfTarget: found === node || node.contains(found), target: describe(found) }
      })()`)) as { selfTarget: boolean; target: string }
      console.log(
        `чип «${label}»: ${Math.round(box.width)}×${Math.round(box.height)} px, цель ${hit.selfTarget ? 'сам чип' : hit.target}`,
      )
      if (!hit.selfTarget) problems.push(`${width}px: касание по чипу «${label}» попадает в «${hit.target}»`)
      if (box.height < 28) problems.push(`${width}px: чип «${label}» ${Math.round(box.height)} px — мелкая цель`)
      await chip.tap({ timeout: 10_000 }).catch(() => undefined)
      await page.waitForTimeout(200)
    }
  }
  await page.screenshot({ path: `..\\_dev_shots\\mobile-taps-${width}.png` })
  await context.close()
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }
  const created = await (await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика нажатий', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id

  try {
    // Полосы и вкладки появляются, когда в проекте есть содержимое.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    await page.waitForTimeout(1200)
    // Вход в новом контексте не повторяем: переносим состояние авторизации.
    const state = await context.storageState()
    for (const width of WIDTHS) {
      await checkWidth(browser, projectId, width, problems, state)
    }
  } finally {
    const removed = await page.request.delete(`${API}/api/projects/${projectId}`, { headers })
    console.log(`\nуборка: проект удалён (${removed.status()})`)
    await context.close()
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимки: mobile-taps-<ширина>.png')
}

await main()
