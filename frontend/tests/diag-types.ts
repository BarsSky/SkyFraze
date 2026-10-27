/**
 * Живая проверка 0.81.0: свои типы карточек, видимость линий графа, карточки вне связей.
 *
 * Запуск: cd frontend && npx tsx tests/diag-types.ts
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
  // С 0.83.0 «Связи» — вкладка: раздел появляется после переключения.
  await page.locator('[data-project-tab="relations"]').click()
  await page.locator('[data-relations]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1500)

  // 1. Свой тип через интерфейс.
  const title = `Фракция ${Date.now().toString().slice(-4)}`
  await page.selectOption('[data-entity-kind-select]', '__new_type__')
  await page.fill('[aria-label="Название нового типа"]', title)
  await page.click('[data-entity-type-add]')
  await page.waitForTimeout(1500)
  const optionTitles = await page.locator('[data-entity-kind-select] option').allTextContents()
  console.log('виды в списке:', optionTitles.join(' | '))
  if (!optionTitles.some((item) => item.includes(title))) {
    problems.push(`новый тип «${title}» не появился в списке видов`)
  }

  // 2. Карточка этого типа.
  const cardName = `Дом ${Date.now().toString().slice(-4)}`
  await page.selectOption('[data-entity-kind-select]', { label: title })
  await page.fill('[aria-label="Имя карточки"]', cardName)
  await page.click('[data-entity-add]')
  await page.waitForTimeout(1500)
  const stats = (await page.locator('[data-relations-stats]').innerText()).trim()
  console.log('статистика после создания:', stats)
  const cardLabel = await evalIn<string>(
    page,
    `
    var items = Array.from(document.querySelectorAll('.ent__item'))
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].textContent.indexOf(arg) !== -1) {
        var kind = items[i].querySelector('.ent__kind')
        return kind ? kind.textContent : '—'
      }
    }
    return 'не найдена'
    `,
    cardName,
  )
  console.log('вид новой карточки:', cardLabel)
  if (cardLabel !== title) problems.push(`подпись вида карточки «${cardLabel}», ожидалось «${title}»`)

  // 3. Карточка без связей видна строкой «вне связей».
  const isolated = await page.locator('[data-entity-graph-isolated]').innerText().catch(() => '')
  console.log('вне связей:', isolated.replace(/\s+/g, ' ').slice(0, 120))
  if (!isolated.includes(cardName)) {
    problems.push(`карточка «${cardName}» не попала в «вне связей» — её не видно в области связей`)
  }

  // 4. Линии графа: цвет, толщина, наконечник.
  const edges = await evalIn<Array<Record<string, unknown>>>(
    page,
    `
    var lines = Array.from(document.querySelectorAll('.egraph__edge'))
    return lines.slice(0, 3).map(function (line) {
      var st = getComputedStyle(line)
      return {
        stroke: st.stroke,
        width: st.strokeWidth,
        markerEnd: line.getAttribute('marker-end'),
        markerStart: line.getAttribute('marker-start'),
      }
    })
    `,
  )
  console.log('рёбра:', JSON.stringify(edges))
  if (edges.length === 0) problems.push('в графе нет рёбер — проверить нечего')
  for (const edge of edges) {
    if (String(edge.stroke) === 'rgb(48, 54, 61)') problems.push('линия связи цвета границы — не видна')
    if (!edge.markerEnd && !edge.markerStart) problems.push('у линии нет наконечника направления')
  }

  await page.locator('[data-relations]').screenshot({ path: `${OUT}\\types-desktop.png` }).catch(() => null)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(900)
  const overflow = await evalIn<number>(
    page,
    `return document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  )
  console.log('гориз. скролл на 390 px:', overflow)
  if (overflow > 1) problems.push(`горизонтальный скролл на 390 px: ${overflow}`)

  console.log('проблемы:', problems.length === 0 ? 'нет' : problems)
  await browser.close()
  if (problems.length > 0) process.exitCode = 1
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
