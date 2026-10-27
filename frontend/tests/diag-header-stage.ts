/**
 * Диагностика шапки, сцены и подписей графа на телефоне (0.77.2).
 *
 * Запуск: cd frontend && npx tsx tests/diag-header-stage.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'

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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.waitForTimeout(2500)

  const header = await evalIn<Record<string, unknown>>(
    page,
    `
    var el = document.querySelector('.layout header')
    var rect = el.getBoundingClientRect()
    var items = []
    var children = el.querySelectorAll('a, button, span, div')
    for (var i = 0; i < children.length; i += 1) {
      var item = children[i]
      var r = item.getBoundingClientRect()
      if (r.width === 0) continue
      if (r.right > window.innerWidth + 1) {
        items.push({
          tag: item.tagName.toLowerCase(),
          cls: String(item.className || '').slice(0, 40),
          text: (item.innerText || '').replace(/\\s+/g, ' ').slice(0, 24),
          right: Math.round(r.right),
          w: Math.round(r.width),
        })
      }
    }
    return {
      vw: window.innerWidth,
      headerW: Math.round(rect.width),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      overflow: el.scrollWidth - el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      wrap: getComputedStyle(el).flexWrap,
      cutOff: items.slice(0, 10),
    }
    `,
  )
  console.log('=== ШАПКА (390 px) ===')
  console.log(JSON.stringify(header, null, 2))
  await page.locator('.layout header, header:not(.ai-head)').first().screenshot({ path: '..\\_dev_shots\\diag-header.png' })

  // Сцена: ширина содержимого против экрана.
  const stage = await evalIn<Record<string, unknown>>(
    page,
    `
    var out = {}
    var stage = document.querySelector('.sf-stage, [data-stage]')
    if (!stage) return { stage: null }
    var rect = stage.getBoundingClientRect()
    out.stage = { w: Math.round(rect.width), overflow: getComputedStyle(stage).overflowX }
    var inner = stage.querySelector('.sf-scene__inner')
    if (inner) {
      var r = inner.getBoundingClientRect()
      out.scene = { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) }
    }
    var copy = stage.querySelector('.sf-copy__scroll')
    if (copy) {
      out.copy = { scrollH: copy.scrollHeight, clientH: copy.clientHeight, ratio: Number((copy.scrollHeight / Math.max(1, copy.clientHeight)).toFixed(2)) }
    }
    out.stageState = stage.getAttribute('data-stage')
    return out
    `,
  )
  console.log('=== СЦЕНА ===')
  console.log(JSON.stringify(stage, null, 2))
  await page.screenshot({ path: '..\\_dev_shots\\diag-stage-390.png' })

  // Подписи графа: торчат ли за холст.
  await page.evaluate(`(async () => {
    var btn = Array.from(document.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === 'Редакторы' })
    if (btn) btn.click()
    return true
  })()`)
  await page.waitForTimeout(1500)
  const labels = await evalIn<Record<string, unknown>>(
    page,
    `
    var canvas = document.querySelector('[data-entity-graph-canvas]')
    if (!canvas) return { canvas: null }
    var rect = canvas.getBoundingClientRect()
    var labels = Array.from(document.querySelectorAll('.egraph__edge-label'))
    return {
      canvas: { w: Math.round(rect.width) },
      labels: labels.map(function (el) {
        var r = el.getBoundingClientRect()
        return {
          text: el.textContent,
          w: Math.round(r.width),
          left: Math.round(r.left - rect.left),
          right: Math.round(r.right - rect.left),
          outside: r.left < rect.left - 1 || r.right > rect.right + 1,
        }
      }),
    }
    `,
  )
  console.log('=== ПОДПИСИ ГРАФА ===')
  console.log(JSON.stringify(labels, null, 2))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
