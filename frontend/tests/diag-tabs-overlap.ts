/**
 * Что перекрывает полосу вкладок (0.86.0).
 *
 * Отчёт: «Меню накрывает кнопки переключения» на вкладке «Версии». Проверяем то, что человек
 * видит руками: попадает ли клик в каждую вкладку, что именно лежит поверх полосы и не заезжает
 * ли содержимое под неё на каждом шаге прокрутки.
 *
 * Запуск: cd frontend && npx tsx tests/diag-tabs-overlap.ts
 * Снимки: _dev_shots/tabs-<tab>-<ширина>.png
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'
const TABS = ['project', 'editors', 'relations', 'versions']

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

/** Что лежит поверх полосы вкладок и попадают ли клики в сами кнопки. */
const PROBE = `
  var row = document.querySelector('.sf-tabs-row')
  var bar = document.querySelector('[data-project-tabs]')
  var header = document.querySelector('.layout header')
  if (!row || !bar) return { missing: true }
  var rect = bar.getBoundingClientRect()
  var rowRect = row.getBoundingClientRect()
  var headerRect = header ? header.getBoundingClientRect() : null
  var tabs = Array.from(document.querySelectorAll('[data-project-tab]')).map(function (button) {
    var r = button.getBoundingClientRect()
    var cx = Math.round(r.left + r.width / 2)
    var cy = Math.round(r.top + r.height / 2)
    var hit = document.elementFromPoint(cx, cy)
    var covered = !(hit === button || button.contains(hit))
    return {
      id: button.getAttribute('data-project-tab'),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      covered: covered,
      hit: hit ? (hit.tagName.toLowerCase() + (hit.getAttribute('data-project-tab') ? '[tab]' : '') + '.' + (hit.className && String(hit.className).split(' ')[0] || '')) : 'null',
    }
  })
  // Всё, что перекрывает вертикальную полосу вкладок по центру каждой кнопки.
  var covering = []
  tabs.forEach(function (tab) {
    var stack = document.elementsFromPoint(tab.x + tab.w / 2, tab.y + tab.h / 2)
    stack.slice(0, stack.findIndex(function (el) { return el.hasAttribute('data-project-tab') }) + 1).forEach(function (el) {
      if (el.hasAttribute('data-project-tab')) return
      var name = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') : '')
      if (covering.indexOf(name) === -1) covering.push(name)
    })
  })
  return {
    headerHeight: headerRect ? Math.round(headerRect.height) : null,
    bar: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
    row: { top: Math.round(rowRect.top), height: Math.round(rowRect.height) },
    tabsVar: getComputedStyle(document.documentElement).getPropertyValue('--sf-header-h').trim(),
    /* Полоса вкладок должна начинаться РОВНО под шапкой: иначе её верх уезжает под шапку. */
    underHeader: headerRect ? Math.round(rowRect.top - headerRect.bottom) : null,
    tabs: tabs,
    covering: covering,
  }
`

async function main() {
  const browser = await chromium.launch()
  const problems: string[] = []

  for (const width of [1440, 1024, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width < 500 ? 780 : 1000 } })
    page.on('pageerror', (e) => problems.push(`${width}: pageerror ${e.message}`))
    await signIn(page)
    await page.goto(`${BASE}/projects/${PROJECT_ID}`)
    await page.locator('[data-project-tabs]').waitFor({ state: 'visible', timeout: 45_000 })
    await page.waitForTimeout(1200)

    for (const tab of TABS) {
      await page.click(`[data-project-tab="${tab}"]`)
      await page.waitForTimeout(900)
      const probe = await evalIn<Record<string, unknown>>(page, PROBE)
      console.log(`${width}px ${tab}: ${JSON.stringify(probe)}`)
      const tabs = (probe.tabs ?? []) as Array<{ id: string; covered: boolean; hit: string }>
      for (const item of tabs) {
        if (item.covered) problems.push(`${width}px ${tab}: вкладка «${item.id}» перекрыта (${item.hit})`)
      }
      // Полоса вкладок стоит ровно под шапкой: 0 — вплотную, отрицательное — верх вкладок
      // спрятан под шапкой (это и был отчёт «меню накрывает кнопки переключения»).
      const under = probe.underHeader as number | null
      if (under === null) {
        problems.push(`${width}px ${tab}: не найдена шапка приложения`)
      } else if (under < -1 || under > 2) {
        problems.push(`${width}px ${tab}: полоса вкладок смещена относительно шапки на ${under}px`)
      }
      const headerHeight = probe.headerHeight as number | null
      const headerVar = Number.parseFloat(String(probe.tabsVar ?? '0'))
      if (headerHeight !== null && Math.abs(headerVar - headerHeight) > 1) {
        problems.push(
          `${width}px ${tab}: --sf-header-h ${headerVar}, а шапка ${headerHeight}px — полоса встанет не туда`,
        )
      }
      await page.screenshot({ path: `${OUT}\\tabs-${tab}-${width}.png`, clip: { x: 0, y: 0, width, height: 340 } })
    }

    // Прокрутка: содержимое уезжает под полосу — это нормально для закреплённой полосы, но
    // фон полосы обязан быть непрозрачным, иначе кнопки «просвечивают» сквозь вкладки.
    for (const tab of TABS) {
      await page.click(`[data-project-tab="${tab}"]`)
      await page.waitForTimeout(600)
      const scrollProbe = await evalIn<Record<string, unknown>>(
        page,
        `
        var main = document.querySelector('main')
        var row = document.querySelector('.sf-tabs-row')
        var rowBottom = row.getBoundingClientRect().bottom
        var max = main.scrollHeight - main.clientHeight
        var worst = 0
        for (var top = 0; top <= max; top += 120) {
          main.scrollTop = top
          await new Promise(function (r) { setTimeout(r, 30) })
          var nodes = document.querySelectorAll('#project-tab-panel button, #project-tab-panel input, #project-tab-panel select')
          nodes.forEach(function (node) {
            var r = node.getBoundingClientRect()
            if (r.height === 0) return
            var overlap = Math.min(r.bottom, rowBottom) - Math.max(r.top, row.getBoundingClientRect().top)
            if (overlap > 0) worst = Math.max(worst, Math.round(overlap))
          })
        }
        main.scrollTop = 0
        var bg = getComputedStyle(row).backgroundColor
        var alpha = 1
        var match = bg.match(/rgba\\(([^)]+)\\)/)
        if (match) alpha = Number(match[1].split(',')[3])
        return { worstOverlap: worst, maxScroll: Math.round(max), background: bg, alpha: alpha }
        `,
      )
      console.log(`${width}px прокрутка ${tab}: ${JSON.stringify(scrollProbe)}`)
      if (!(Number((scrollProbe.alpha as number) ?? 0) >= 0.999)) {
        problems.push(`${width}px ${tab}: полоса вкладок полупрозрачна (${scrollProbe.background})`)
      }
    }
    await page.close()
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет')
}

await main()
