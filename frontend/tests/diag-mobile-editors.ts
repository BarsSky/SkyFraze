/**
 * Диагностика малого экрана: переполнение по ширине и «тяжёлая» прокрутка (0.77.2).
 *
 * Отвечает числами на два вопроса из отчёта:
 *   1. что именно шире экрана на вкладке «Редакторы» и на сколько;
 *   2. куда уходит палец: сколько пикселей прокрутки даёт жест, не отменяет ли кто-то
 *      `touchmove` (тогда жест «съедается» и приходится вести пальцем дальше), сколько
 *      длинных задач при прокрутке.
 *
 * Тела замеров передаются СТРОКОЙ (`evalIn`), а не функцией: tsx добавляет в вычисляемые
 * функции обёртку `__name`, которой в браузере нет, и любой `const f = () => {}` внутри
 * `page.evaluate` падает с «__name is not defined».
 *
 * Запуск (backend :8181 и vite :5173 подняты):
 *   cd frontend && npx tsx tests/diag-mobile-editors.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'

/** Выполнить строку кода в странице с аргументом `arg`. */
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

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, hasTouch: true })
  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1500)

  // 1. Что шире экрана — внутри панели редакторов (сцена полноэкранная по замыслу, её не считаем).
  const width = await evalIn<Record<string, unknown>>(
    page,
    `
    var vw = document.documentElement.clientWidth
    var box = function (selector) {
      var el = document.querySelector(selector)
      if (!el) return null
      var rect = el.getBoundingClientRect()
      var style = getComputedStyle(el)
      return {
        width: Math.round(rect.width),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: style.overflowX,
        cols: style.gridTemplateColumns,
      }
    }
    var wide = []
    var nodes = document.querySelectorAll('[data-editor-panel] *')
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i]
      var rect = el.getBoundingClientRect()
      if (rect.width <= vw + 1 || rect.width === 0 || rect.height === 0) continue
      wide.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 70),
        width: Math.round(rect.width),
        right: Math.round(rect.right),
        text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
      })
    }
    wide.sort(function (a, b) { return b.width - a.width })
    return {
      viewport: vw,
      doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw },
      main: box('main'),
      editorPanel: box('[data-editor-panel]'),
      grid: box('.ed-panel__grid'),
      tree: box('.ed-panel__tree'),
      editor: box('.ed-panel__editor'),
      entities: box('[data-entities]'),
      graph: box('[data-entity-graph]'),
      wide: wide.slice(0, 10),
    }
    `,
  )
  console.log('=== ШИРИНА (360 px) ===')
  console.log(JSON.stringify(width, null, 2))

  // 2. Жест пальцем через CDP: считаем, сколько прокрутки он дал и не отменяли ли touchmove.
  await evalIn(
    page,
    `
    window.__touchLog = []
    document.addEventListener('touchmove', function (event) {
      var target = event.target
      window.__touchLog.push({
        tag: target ? target.tagName.toLowerCase() : '—',
        cls: target ? String(target.className || '').slice(0, 50) : '',
        prevented: event.defaultPrevented,
      })
    }, { passive: true })
    return true
    `,
  )
  const before = await evalIn<{ main: number }>(
    page,
    `var main = document.querySelector('main'); return { main: main.scrollTop, doc: document.scrollingElement.scrollTop }`,
  )
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 560 }] })
  for (let step = 1; step <= 10; step += 1) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 180, y: 560 - step * 40 }],
    })
    await page.waitForTimeout(16)
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(700)
  const after = await evalIn<Record<string, unknown>>(
    page,
    `
    var main = document.querySelector('main')
    var log = window.__touchLog || []
    var prevented = log.filter(function (item) { return item.prevented })
    return {
      main: main.scrollTop,
      doc: document.scrollingElement.scrollTop,
      touchEvents: log.length,
      preventedCount: prevented.length,
      preventedTargets: prevented.slice(0, 5),
      targets: log.slice(0, 4),
    }
    `,
  )
  console.log('=== ЖЕСТ (400 px пальцем) ===')
  console.log(JSON.stringify({ before, after }, null, 2))

  // 3. Длинные задачи и кадры во время программной прокрутки на 1200 px.
  const perf = await evalIn<Record<string, unknown>>(
    page,
    `
    var longTasks = 0
    var observer = new PerformanceObserver(function (list) { longTasks += list.getEntries().length })
    try { observer.observe({ entryTypes: ['longtask'] }) } catch (e) { return { longTasks: -1 } }
    var main = document.querySelector('main')
    var start = performance.now()
    var frames = 0
    var running = true
    var tick = function () { if (!running) return; frames += 1; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    for (var i = 0; i < 30; i += 1) {
      main.scrollTop += 40
      await new Promise(function (resolve) { setTimeout(resolve, 16) })
    }
    running = false
    observer.disconnect()
    return { longTasks: longTasks, frames: frames, ms: Math.round(performance.now() - start) }
    `,
  )
  console.log('=== ПРОКРУТКА 1200 px ===')
  console.log(JSON.stringify(perf, null, 2))

  await page.screenshot({ path: '..\\_dev_shots\\diag-360-editors.png', fullPage: false })
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
