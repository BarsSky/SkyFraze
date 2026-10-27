/**
 * Живая проверка области «Связи» (0.79.0): раздел между показом проекта и редакторами,
 * граф в «пространстве», раскрывающаяся карточка узла.
 *
 * Запуск: cd frontend && npx tsx tests/diag-relations.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })

  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-project-tabs]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1200)

  // Кнопка «Связи» рядом с «Редакторами» (0.83.0): переключает ВКЛАДКУ, а не прокручивает
  // страницу — поэтому проверяем и переход, и то, что страница не уехала.
  const jump = page.locator('[data-relations-open]')
  console.log('кнопка «Связи» на стадии:', (await jump.count()) > 0)
  if ((await jump.count()) === 0) problems.push('кнопки «Связи» в строке действий нет')
  await page.locator('.sf-topbar__actions, [data-stage]').first().screenshot({ path: `${OUT}\\relations-actions.png` })

  const before = await evalIn<number>(
    page,
    `var m = document.querySelector('main'); return Math.round(m.scrollTop)`,
  )
  await jump.first().click()
  await page.locator('[data-relations]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(800)
  const after = await evalIn<number>(
    page,
    `var m = document.querySelector('main'); return Math.round(m.scrollTop)`,
  )
  const activeTab = await page.locator('[data-project-tab].is-active').getAttribute('data-project-tab')
  console.log(`переход: вкладка «${activeTab}», прокрутка ${before} → ${after}`)
  if (activeTab !== 'relations') problems.push(`кнопка «Связи» открыла вкладку «${activeTab}»`)
  // Прокрутка может уменьшиться сама: панель вкладки короче прежней страницы, и браузер
  // прижимает scrollTop к её высоте. Плохо — если переход УВЁЛ страницу вниз (человек теряет место).
  if (after > before + 4) problems.push('переход к «Связям» увёл страницу вниз — он должен быть мгновенным')

  const section = page.locator('[data-relations]')
  await section.screenshot({ path: `${OUT}\\relations-dark.png` })

  // Раскрывающаяся карточка (0.84.0): в ЦЕНТРЕ холста, не полосой и не сбоку от узла.
  const center = page.locator('[data-entity-graph-center]')
  await center.click()
  await page.waitForTimeout(500)
  const geometry = await evalIn<Record<string, unknown>>(
    page,
    `
    var card = document.querySelector('[data-entity-graph-card]')
    var canvas = document.querySelector('[data-entity-graph-canvas]')
    if (!card || !canvas) return { missing: true }
    var c = card.getBoundingClientRect()
    var k = canvas.getBoundingClientRect()
    return {
      card: { w: Math.round(c.width), h: Math.round(c.height) },
      canvas: { w: Math.round(k.width), h: Math.round(k.height) },
      insideCanvas: c.left >= k.left - 1 && c.right <= k.right + 1 && c.top >= k.top - 1 && c.bottom <= k.bottom + 1,
      offsetX: Math.round(c.left + c.width / 2 - (k.left + k.width / 2)),
      offsetY: Math.round(c.top + c.height / 2 - (k.top + k.height / 2)),
      fullWidth: Math.round(c.width) >= Math.round(k.width) - 24,
    }
    `,
  )
  console.log('карточка узла:', JSON.stringify(geometry))
  if ((geometry as { fullWidth?: boolean }).fullWidth) {
    problems.push('карточка узла во всю ширину холста — это полоса, а не карточка')
  }
  if ((geometry as { insideCanvas?: boolean }).insideCanvas === false) {
    problems.push('карточка узла выходит за холст')
  }
  if (Math.abs((geometry as { offsetX?: number }).offsetX ?? 99) > 4) {
    problems.push(`карточка стоит не по центру холста: смещение ${(geometry as { offsetX?: number }).offsetX} px`)
  }
  await section.screenshot({ path: `${OUT}\\relations-card-dark.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Светлая тема: фон «пространства» не должен превращаться в белое поле с невидимой сеткой.
  await page.getByRole('button', { name: 'Переключить тему' }).click()
  await page.waitForTimeout(900)
  await section.screenshot({ path: `${OUT}\\relations-light.png` })
  await page.getByRole('button', { name: 'Переключить тему' }).click()
  await page.waitForTimeout(600)

  // Телефон: раздел и карточка-лист.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(900)
  const mobile = await evalIn<Record<string, unknown>>(
    page,
    `
    var section = document.querySelector('[data-relations]')
    var rect = section.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
    `,
  )
  console.log('моб. раздел:', JSON.stringify(mobile))
  if ((mobile as { docOverflow?: number }).docOverflow) problems.push('на 390 px горизонтальный скролл')
  await section.screenshot({ path: `${OUT}\\relations-mobile.png` })

  console.log('проблемы:', problems.length === 0 ? 'нет' : problems)
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
