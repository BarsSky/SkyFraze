/**
 * Мобильная проверка: меню «Ещё», отступы вкладок, редакторы и чипы (0.88.0).
 *
 * Отчёт: «из меню видно только кнопку Ещё и больше ничего», «элемент переключения по главам и
 * подсобытиям в одну строку», «редактор не всё подстроен под маленький экран», «в каждом табе
 * содержимое имеет пустой отступ от кнопок переключения на разном расстоянии».
 *
 * Запуск: cd frontend && npx tsx tests/diag-mobile-tabs.ts
 * Снимки: _dev_shots/m-*.png
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'
const WIDTH = Number(process.env.WIDTH ?? 360)

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: 780 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  })
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })

  // 1. Меню «Ещё» в шапке.
  // Кнопка появляется после того, как приехало состояние входа и определилась ширина.
  await page.locator('[data-header-more]').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
  const more = page.locator('[data-header-more]')
  const moreCount = await more.count()
  const inlineLinks = await page.locator('.auth-links a').allInnerTexts()
  console.log(`кнопка «Ещё»: ${moreCount > 0}; разделов в строке: ${JSON.stringify(inlineLinks)}`)
  if (moreCount === 0) problems.push('кнопки «Ещё» в шапке нет — проверять нечего')
  else {
    await more.click()
    await page.waitForTimeout(400)
    const menu = await evalIn<Record<string, unknown>>(
      page,
      `
      var menu = document.querySelector('[data-header-menu], [role="menu"]')
      var header = document.querySelector('.layout header')
      if (!menu) return { missing: true }
      var r = menu.getBoundingClientRect()
      return {
        items: menu.querySelectorAll('[role="menuitem"]').length,
        actions: menu.querySelectorAll('[data-header-action]').length,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
        insideViewport: r.left >= -1 && r.right <= window.innerWidth + 1,
        headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : null,
        z: getComputedStyle(menu).zIndex,
      }
      `,
    )
    console.log(`меню «Ещё»: ${JSON.stringify(menu)}`)
    await page.screenshot({ path: `${OUT}\\m-header-menu.png` })
    const menuRec = menu as {
      missing?: boolean
      items?: number
      actions?: number
      visible?: boolean
      insideViewport?: boolean
    }
    if (menuRec.missing) problems.push('меню «Ещё» не открылось: в DOM нет [data-header-menu]')
    else {
      if ((menuRec.items ?? 0) === 0) problems.push('в меню «Ещё» нет пунктов')
      if (!menuRec.visible) problems.push('меню «Ещё» вне экрана')
      if (menuRec.insideViewport === false) problems.push('меню «Ещё» вылезает за правый/левый край')
    }
    // На совсем узком экране тема и выход живут в меню — иначе в строке остаётся одна кнопка.
    if (WIDTH <= 420 && (menuRec.actions ?? 0) < 2) {
      problems.push(`в меню «Ещё» ${menuRec.actions} действия, ожидалось 2 (тема и выход)`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  if (WIDTH <= 420 && inlineLinks.length === 0) {
    problems.push('на узком экране в строке нет ни одного раздела — видна только кнопка «Ещё»')
  }

  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-project-tabs]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1200)

  // 2. Отступ от полосы вкладок до содержимого — одинаковый у рабочих вкладок.
  //
  // Меряем ВЕРХ САМОГО РАЗДЕЛА, а не заголовка внутри него: у заголовков разные шрифт и
  // межстрочный интервал, и верх строки гуляет на 6–8 px без всякой разметки. «Проект» не
  // сравниваем: его содержимое — fixed-слой сцены со своими смещениями от --sf-free-top.
  const firstBlock: Record<string, string> = {
    editors: '#project-tab-panel > .ed-panel',
    relations: '#project-tab-panel > .relations',
    versions: '#project-tab-panel > .sf-versions--embedded',
  }
  const gaps: Record<string, number> = {}
  for (const tab of ['editors', 'relations', 'versions'] as const) {
    await page.click(`[data-project-tab="${tab}"]`)
    await page.waitForTimeout(900)
    const gap = await evalIn<number>(
      page,
      `
      var row = document.querySelector('.sf-tabs-row').getBoundingClientRect()
      var block = document.querySelector(arg.selector)
      if (!block) return -1
      return Math.round(block.getBoundingClientRect().top - row.bottom)
      `,
      { selector: firstBlock[tab] },
    )
    gaps[tab] = gap
    await page.screenshot({ path: `${OUT}\\m-tab-${tab}.png` })
  }
  console.log('отступ от вкладок до раздела:', JSON.stringify(gaps))
  const values = Object.values(gaps).filter((value) => value >= 0)
  if (values.length !== 3) problems.push(`не все вкладки измерились: ${JSON.stringify(gaps)}`)
  if (values.length > 1) {
    const spread = Math.max(...values) - Math.min(...values)
    if (spread > 4) problems.push(`отступы вкладок разные: ${JSON.stringify(gaps)} (разброс ${spread} px)`)
  }

  // 3. Чипы глав: две строки (главы и под-события активной главы).
  await page.click('[data-project-tab="project"]')
  await page.waitForTimeout(1200)
  const chips = await evalIn<Record<string, unknown>>(
    page,
    `
    var root = document.querySelector('.sf-chips')
    if (!root) return { missing: true }
    var rows = root.querySelectorAll('[data-chips-row]')
    var r = root.getBoundingClientRect()
    var chapters = root.querySelectorAll('[data-chips-row="chapters"] .sf-chip')
    var steps = root.querySelectorAll('[data-chips-row="steps"] .sf-chip')
    return {
      rows: rows.length,
      height: Math.round(r.height),
      chapters: chapters.length,
      steps: steps.length,
      chapterOverflow: Array.from(chapters).filter(function (c) {
        var b = c.getBoundingClientRect()
        return b.right > window.innerWidth + 1 || b.left < -1
      }).length,
      horizontal: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }
    `,
  )
  console.log('чипы:', JSON.stringify(chips))
  await page.screenshot({ path: `${OUT}\\m-chips.png` })
  const chipsRec = chips as { missing?: boolean; rows?: number; steps?: number }
  if (chipsRec.missing) problems.push('чипов глав нет на показе проекта')
  else if ((chipsRec.steps ?? 0) > 0 && (chipsRec.rows ?? 0) < 2) {
    // На стенд-проекте под-событий может не быть вовсе — тогда одна полоса и есть правильный вид.
    problems.push(`полоса чипов в ${chipsRec.rows} строк(и), а под-события есть — ждали 2`)
  }

  // 4. Редакторы на телефоне: нет горизонтального переполнения, строки не обрезаются экраном.
  await page.click('[data-project-tab="editors"]')
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1200)
  const editors = await evalIn<Record<string, unknown>>(
    page,
    `
    var panel = document.querySelector('[data-editor-panel]')
    var doc = document.documentElement
    var wide = []
    if (panel) {
      Array.from(panel.querySelectorAll('*')).forEach(function (el) {
        var r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > window.innerWidth + 2) {
          wide.push((el.className && String(el.className).split(' ')[0] || el.tagName) + ':' + Math.round(r.right - window.innerWidth))
        }
      })
    }
    return {
      horizontal: Math.max(0, doc.scrollWidth - doc.clientWidth),
      wide: wide.slice(0, 8),
      wideCount: wide.length,
      rows: panel ? panel.querySelectorAll('.ed-row').length : 0,
    }
    `,
  )
  console.log('редакторы:', JSON.stringify(editors))
  await page.screenshot({ path: `${OUT}\\m-editors.png` })
  const editorsRec = editors as { horizontal?: number; wideCount?: number; wide?: string[] }
  if ((editorsRec.horizontal ?? 0) > 0) {
    problems.push(`в редакторах горизонтальное переполнение документа ${editorsRec.horizontal} px`)
  }
  if ((editorsRec.wideCount ?? 0) > 0) {
    problems.push(`в редакторах ${editorsRec.wideCount} элементов за правым краем: ${(editorsRec.wide ?? []).join(', ')}`)
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
