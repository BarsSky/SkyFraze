/**
 * «Маленькая ширина, большая высота» (0.89.0): телефон в режиме полной версии и узкие высокие
 * окна десктопа — 1080×2340 CSS.
 *
 * Отчёт: «в десктопной версии поле с текстом сжалось по тексту», «у редактора элементы вылезают за
 * экран», «на вкладке связи таблица матриц идёт впритык к низу».
 *
 * Проверяем: горизонтальное переполнение на каждой вкладке, какие элементы выходят за экран,
 * геометрию листа кадра (ширина/высота/пустое место вокруг) и зазор под матрицей.
 *
 * Запуск: cd frontend && npx tsx tests/diag-tall.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'
const WIDTH = Number(process.env.WIDTH ?? 1080)
const HEIGHT = Number(process.env.HEIGHT ?? 2340)
/** Ширины для перебора: телефон в «полной версии» Opera — это 980–1080 CSS px. */
const WIDTHS = (process.env.WIDTHS ?? '').split(',').map((value) => Number(value.trim())).filter((value) => value > 0)

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })
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
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-project-tabs]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1500)

  // 1. Горизонтальное переполнение по вкладкам + кто именно выходит за экран.
  for (const tab of ['project', 'editors', 'relations', 'versions'] as const) {
    await page.click(`[data-project-tab="${tab}"]`)
    await page.waitForTimeout(1000)
    const info = await evalIn<Record<string, unknown>>(
      page,
      `
      var doc = document.documentElement
      var wide = []
      Array.from(document.querySelectorAll('#project-tab-panel *')).forEach(function (el) {
        var r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        if (r.right <= window.innerWidth + 2) return
        // Сцена — fixed-слой во весь экран: её фон и картинки шире окна намеренно (зум сцены),
        // и документ от них не прокручивается. Смотрим только поток.
        var inStage = el.closest('.sf-stage, .sf-scopelayer, .sf-sky, .sf-scene')
        if (inStage) return
        var cls = el.className && String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')
        var name = (cls || el.tagName.toLowerCase()) + ' +' + Math.round(r.right - window.innerWidth)
        if (wide.indexOf(name) === -1) wide.push(name)
      })
      return {
        horizontal: Math.max(0, doc.scrollWidth - doc.clientWidth),
        scrollX: Math.round(window.scrollX),
        wide: wide.slice(0, 12),
        wideCount: wide.length,
      }
      `,
    )
    console.log(`${tab}: ${JSON.stringify(info)}`)
    const rec = info as { horizontal?: number; wideCount?: number; wide?: string[] }
    if ((rec.horizontal ?? 0) > 0) {
      problems.push(`${tab}: горизонтальное переполнение ${rec.horizontal} px (${(rec.wide ?? []).join(', ')})`)
    } else if ((rec.wideCount ?? 0) > 0) {
      problems.push(`${tab}: ${rec.wideCount} элементов за экраном: ${(rec.wide ?? []).join(', ')}`)
    }
  }

  // 2. Лист кадра на высоком экране: ширина/высота и сколько места пустует.
  await page.click('[data-project-tab="project"]')
  await page.waitForTimeout(1200)
  const copy = await evalIn<Record<string, unknown>>(
    page,
    `
    var copy = document.querySelector('.sf-copy')
    if (!copy) return { missing: true }
    var r = copy.getBoundingClientRect()
    var scroll = copy.querySelector('.sf-copy__scroll')
    return {
      width: Math.round(r.width),
      height: Math.round(r.height),
      ratio: Math.round((r.width / window.innerWidth) * 100),
      top: Math.round(r.top),
      left: Math.round(r.left),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      // Сколько текста не влезает: прокрутка внутри листа.
      textScroll: scroll ? Math.round(scroll.scrollHeight - scroll.clientHeight) : null,
    }
    `,
  )
  console.log(`лист кадра: ${JSON.stringify(copy)}`)
  await page.screenshot({ path: `${OUT}\\t-project-copy.png` })

  // 3. Матрица связей: зазор до низа раздела и до низа документа.
  await page.click('[data-project-tab="relations"]')
  await page.locator('[data-entity-matrix]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1000)
  const matrix = await evalIn<Record<string, unknown>>(
    page,
    `
    var table = document.querySelector('.ent__matrix-table')
    var details = document.querySelector('.ent__matrix')
    var section = document.querySelector('[data-relations]')
    if (!table || !details || !section) return { missing: true }
    var t = table.getBoundingClientRect()
    var d = details.getBoundingClientRect()
    var s = section.getBoundingClientRect()
    var main = document.querySelector('main')
    return {
      // Зазор между таблицей и низом раздела (внутренний отступ).
      sectionTail: Math.round(s.bottom - t.bottom),
      detailsTail: Math.round(d.bottom - t.bottom),
      // Сколько остаётся до конца прокрутки: если 0 — таблица «упирается» в низ.
      scrollTail: Math.round(main.scrollHeight - (main.scrollTop + main.clientHeight)),
      tableWidth: Math.round(t.width),
      viewportWidth: window.innerWidth,
    }
    `,
  )
  console.log(`матрица: ${JSON.stringify(matrix)}`)
  await page.screenshot({ path: `${OUT}\\t-relations-matrix.png` })

  // 4. Редакторы: элементы за краем и ширина строк.
  await page.click('[data-project-tab="editors"]')
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1000)
  const editors = await evalIn<Record<string, unknown>>(
    page,
    `
    var doc = document.documentElement
    var rows = Array.from(document.querySelectorAll('.ed-row'))
    var wideRows = rows.filter(function (row) {
      var r = row.getBoundingClientRect()
      return r.right > window.innerWidth + 2
    }).length
    return {
      horizontal: Math.max(0, doc.scrollWidth - doc.clientWidth),
      rows: rows.length,
      wideRows: wideRows,
      rowWidth: rows.length ? Math.round(rows[0].getBoundingClientRect().width) : null,
      panelWidth: Math.round((document.querySelector('[data-editor-panel]') || {getBoundingClientRect: () => ({width: 0})}).getBoundingClientRect().width),
    }
    `,
  )
  console.log(`редакторы: ${JSON.stringify(editors)}`)
  await page.screenshot({ path: `${OUT}\\t-editors.png` })

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
