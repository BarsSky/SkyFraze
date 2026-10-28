/**
 * Живая проверка переходов из «Связей» (0.87.0).
 *
 * Отчёт: «переходы по матрице связей перестали работать по нажатию — не открывают место в
 * редакторе или проекте». Проверяем всю цепочку руками:
 *
 *   1. клик по числу в матрице раскрывает карточку упоминания (глава, цитата, список кадров);
 *   2. «К редактированию» — вкладка «Редакторы» и выбранный кадр;
 *   3. «К проекту» — вкладка «Проект» и показ встал на этот кадр (виден его заголовок).
 *
 * Запуск: cd frontend && npx tsx tests/diag-matrix-nav.ts
 * Снимки: _dev_shots/matrix-card.png, matrix-to-editors.png, matrix-to-project.png
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
  await page.locator('[data-project-tab="relations"]').click()
  await page.locator('[data-entity-matrix]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(800)

  // 1. Карточка упоминания.
  //
  // На стенд-проекте в клетке матрицы по одному кадру, поэтому выбор из нескольких кадров здесь
  // не проверить; он закреплён юнит-тестами панели (выбор второго кадра ведёт именно в него) и
  // расчётом прокрутки (`scrollDeltaForFrame`). Здесь — весь путь руками на живых данных.
  const cells = page.locator('[data-matrix-cell]')
  const total = await cells.count()
  if (total === 0) {
    problems.push('в матрице нет ни одной клетки с упоминаниями — проверять нечего')
  }
  const cellIndex = 0
  await cells.first().click()
  await page.locator('[data-mention-card]').waitFor({ state: 'visible', timeout: 10_000 })
  const cell = page.locator('[data-matrix-cell]').nth(cellIndex)
  const cellCount = await cell.innerText()
  const card = page.locator('[data-mention-card]')
  await card.waitFor({ state: 'visible', timeout: 10_000 })
  const cardText = (await card.innerText()).replace(/\s+/g, ' ')
  const frames = await page.locator('[data-mention-frame]').count()
  const frameTitles = await page.locator('[data-mention-frame]').allInnerTexts()
  const quote = await page.locator('[data-mention-quote]').innerText().catch(() => '')
  console.log(`клеток ${total}; карточка: «${cardText.slice(0, 140)}»; кадров ${frames}; цитата ${quote}`)
  await card.screenshot({ path: `${OUT}\\matrix-card.png` })
  if (!cardText.includes('глава')) problems.push('в карточке нет названия главы')
  if (frames === 0) problems.push('в карточке нет списка кадров')
  if (!quote.includes('«')) problems.push('в карточке нет цитаты упоминания')
  const cellNumber = Number(cellCount)
  const countText = await page.locator('[data-mention-count]').innerText()
  if (Number(countText) !== cellNumber) {
    problems.push(`в карточке «упоминаний: ${countText}», а в клетке ${cellNumber}`)
  }
  const selectedFrameTitle = (frameTitles[0] ?? '').split('\n')[0].trim()
  await page.locator('[data-mention-to-editors]').click()
  await page.waitForTimeout(1200)
  const editorsState = await evalIn<Record<string, unknown>>(
    page,
    `
    var active = document.querySelector('.ed-row--active .ed-row__title, .ed-row--active')
    var panel = document.querySelector('[data-editor-panel]')
    return {
      tab: (document.querySelector('[data-project-tab].is-active') || {}).textContent || '',
      panel: !!panel,
      active: active ? active.textContent.trim() : '',
      card: !!document.querySelector('[data-mention-card]'),
    }
    `,
  )
  console.log(`к редактированию: ${JSON.stringify(editorsState)}`)
  if ((editorsState.tab as string) !== 'Редакторы') problems.push('вкладка не «Редакторы»')
  if (!editorsState.panel) problems.push('панель редакторов не появилась')
  if (editorsState.card) problems.push('карточка упоминания не закрылась')
  if (selectedFrameTitle && !(editorsState.active as string).includes(selectedFrameTitle)) {
    problems.push(
      `в редакторе выбран «${editorsState.active}», а в карточке был кадр «${selectedFrameTitle}»`,
    )
  }
  await page.screenshot({ path: `${OUT}\\matrix-to-editors.png` })

  // 3. К проекту: показ встаёт на нужный кадр.
  await page.locator('[data-project-tab="relations"]').click()
  await page.locator('[data-entity-matrix]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(600)
  await page.locator('[data-matrix-cell]').nth(cellIndex).click()
  await page.locator('[data-mention-card]').waitFor({ state: 'visible', timeout: 10_000 })
  const targetTitle = (await page.locator('[data-mention-frame].is-active').innerText())
    .split('\n')[0]
    .trim()
  await page.locator('[data-mention-to-project]').click()
  await page.waitForTimeout(1800)
  const projectState = await evalIn<Record<string, unknown>>(
    page,
    `
    var copy = document.querySelector('.sf-copy__title, .sf-copy')
    return {
      tab: (document.querySelector('[data-project-tab].is-active') || {}).textContent || '',
      title: copy ? copy.textContent.trim().slice(0, 80) : '',
      stage: !!document.querySelector('.sf-stage'),
      scroll: Math.round((document.querySelector('main') || { scrollTop: 0 }).scrollTop),
    }
    `,
  )
  console.log(`к проекту (кадр «${targetTitle}»): ${JSON.stringify(projectState)}`)
  if ((projectState.tab as string) !== 'Проект') problems.push('вкладка не «Проект»')
  if (!projectState.stage) problems.push('стадия не появилась')
  if (targetTitle && !(projectState.title as string).includes(targetTitle)) {
    problems.push(`показ проекта стоит на «${projectState.title}», а ждали «${targetTitle}»`)
  }
  await page.screenshot({ path: `${OUT}\\matrix-to-project.png` })

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
