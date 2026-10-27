/**
 * Диагностика ширины на разных экранах (0.77.2): где именно вкладка «Редакторы» перестаёт
 * влезать в экран. Тела замеров — строками, см. объяснение в diag-mobile-editors.ts.
 *
 * Запуск: cd frontend && npx tsx tests/diag-width-sweep.ts
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
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1500)

  const rows: unknown[] = []
  for (const width of [320, 360, 390, 414, 480, 560, 640, 720, 768, 900]) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForTimeout(700)
    const row = await evalIn<Record<string, unknown>>(
      page,
      `
      var vw = document.documentElement.clientWidth
      var grid = document.querySelector('.ed-panel__grid')
      var tree = document.querySelector('.ed-tree')
      var editor = document.querySelector('.ed-editor')
      var panel = document.querySelector('[data-editor-panel]')
      var graph = document.querySelector('[data-entity-graph]')
      var ents = document.querySelector('[data-entities]')
      var measure = function (el) {
        if (!el) return null
        var rect = el.getBoundingClientRect()
        return {
          w: Math.round(rect.width),
          scrollW: el.scrollWidth,
          clip: el.scrollWidth > el.clientWidth + 1,
        }
      }
      var wide = []
      var nodes = document.querySelectorAll('main *')
      for (var i = 0; i < nodes.length; i += 1) {
        var el = nodes[i]
        var rect = el.getBoundingClientRect()
        if (rect.width <= vw + 1 || rect.width === 0 || rect.height === 0) continue
        var style = getComputedStyle(el)
        if (style.position === 'fixed') continue
        wide.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 50),
          w: Math.round(rect.width),
        })
      }
      wide.sort(function (a, b) { return b.w - a.w })
      return {
        vw: vw,
        docOverflow: document.documentElement.scrollWidth - vw,
        mainOverflow: (function () { var m = document.querySelector('main'); return m.scrollWidth - m.clientWidth })(),
        gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        panel: measure(panel),
        tree: measure(tree),
        editor: measure(editor),
        entities: measure(ents),
        graph: measure(graph),
        wide: wide.slice(0, 5),
      }
      `,
    )
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  console.log('\n=== СВОДКА ===')
  console.log(JSON.stringify(rows, null, 1).slice(0, 6000))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
