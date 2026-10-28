/**
 * Живая проверка двух полос чипов на телефоне (0.88.0).
 *
 * Отчёт: «переключатель по главам и подсобытиям располагает сначала все главы, а потом
 * подсобытия главы в одну строку — неудобно ориентироваться». Теперь сверху главы, снизу
 * под-события активной главы, и полоса тянется вниз, сдвигая показ.
 *
 * На стенд-проекте под-событий нет, поэтому проект создаётся через интерфейс: глава + два
 * подсобытия. За собой скрипт его убирает.
 *
 * Запуск: cd frontend && npx tsx tests/diag-chips.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const OUT = '..\\_dev_shots'

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true })
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

  const title = `Чипы ${Date.now().toString().slice(-5)}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 })
  const projectId = page.url().split('/').pop() as string

  // Глава и два под-события — через интерфейс (структура важнее текста).
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  await page.locator('[data-project-tab="editors"]').click()
  const panel = page.locator('[data-editor-panel]')
  await panel.locator('.ed-row').first().waitFor({ state: 'visible', timeout: 20_000 })
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole('button', { name: '+ подсобытие' }).click()
    await page.waitForTimeout(500)
  }
  await page.locator('[data-project-tab="project"]').click()
  await page.waitForTimeout(1500)

  const chips = await evalIn<Record<string, unknown>>(
    page,
    `
    var root = document.querySelector('.sf-chips')
    if (!root) return { missing: true }
    var rows = Array.from(root.querySelectorAll('[data-chips-row]'))
    var rect = root.getBoundingClientRect()
    var chapters = root.querySelectorAll('[data-chips-row="chapters"] .sf-chip')
    var steps = root.querySelectorAll('[data-chips-row="steps"] .sf-chip')
    var chapterRow = root.querySelector('[data-chips-row="chapters"]')
    var stepRow = root.querySelector('[data-chips-row="steps"]')
    return {
      rows: rows.length,
      height: Math.round(rect.height),
      chapters: chapters.length,
      steps: steps.length,
      chaptersTop: chapterRow ? Math.round(chapterRow.getBoundingClientRect().top) : null,
      stepsTop: stepRow ? Math.round(stepRow.getBoundingClientRect().top) : null,
      // Полоса не должна вылезать за экран по горизонтали: строки прокручиваются внутри.
      docOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      // Сцена и лист кадра начинаются ПОД полосой: высота чипов уходит в --sf-chips-h.
      chipsVar: getComputedStyle(document.documentElement).getPropertyValue('--sf-chips-h').trim(),
    }
    `,
  )
  console.log('чипы:', JSON.stringify(chips))
  await page.screenshot({ path: `${OUT}\\m-chips-rows.png` })
  const rec = chips as {
    missing?: boolean
    rows?: number
    height?: number
    chapters?: number
    steps?: number
    chaptersTop?: number
    stepsTop?: number
    docOverflow?: number
    chipsVar?: string
  }
  if (rec.missing) problems.push('полосы чипов на показе проекта нет')
  else {
    if ((rec.rows ?? 0) !== 2) problems.push(`полос ${rec.rows}, ожидалось 2 (главы и под-события)`)
    if ((rec.steps ?? 0) !== 2) problems.push(`шагов в нижней полосе ${rec.steps}, ожидалось 2`)
    if ((rec.height ?? 0) < 60) problems.push(`высота полосы ${rec.height} px — две строки не поместились`)
    if ((rec.stepsTop ?? 0) <= (rec.chaptersTop ?? 0)) {
      problems.push('под-события нарисованы не под главами')
    }
    if ((rec.docOverflow ?? 0) > 0) problems.push(`горизонтальное переполнение страницы ${rec.docOverflow} px`)
    if (!rec.chipsVar || rec.chipsVar === '0px') {
      problems.push('высота полосы чипов не попала в --sf-chips-h: показ не сдвинется')
    }
  }

  // Показ проекта не наезжает на полосу: лист кадра начинается ниже.
  const overlap = await evalIn<number>(
    page,
    `
    var chips = document.querySelector('.sf-chips')
    var copy = document.querySelector('.sf-copy')
    if (!chips || !copy) return -1
    var c = chips.getBoundingClientRect(), k = copy.getBoundingClientRect()
    return Math.round(k.top - c.bottom)
    `,
  )
  console.log(`зазор от чипов до листа кадра: ${overlap} px`)
  if (overlap >= 0 && overlap < 2) problems.push('лист кадра вплотную к полосе чипов — наезжает')

  // За собой убираем.
  const token = await evalIn<string>(
    page,
    `return JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken`,
  )
  await page.request.fetch(`${API}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

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
