/** Живой инструмент: матрица «персонажи × главы» (0.71.0, в CI не гоняется). */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'visual.entities@example.com'
const PASSWORD = 'hunter22!'

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
  await signIn(page)
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(1200)
  await page.locator('a[href*="/projects/"]').first().click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 30_000 })

  // Второй кадр в главе: без него матрица будет из одного столбца и одной клетки.
  const addSub = page.getByRole('button', { name: '+ подсобытие' })
  if (await addSub.count()) {
    await addSub.click()
    await page.waitForTimeout(900)
    const body = page.locator('.ed-editor textarea').first()
    await body.fill('Дом на холме и письмо для Анны.')
    await page.waitForTimeout(900)
  }

  await page.locator('[data-entities] > summary').click()
  const matrix = page.locator('[data-entity-matrix] > summary')
  if (await matrix.count()) {
    await matrix.click()
    await page.waitForTimeout(400)
    await page.locator('[data-entity-matrix]').scrollIntoViewIfNeeded()
    await page.locator('[data-entity-matrix]').screenshot({ path: 'visual-matrix.png' })
    const rows = await page.locator('[data-matrix-row]').count()
    console.log(`матрица: строк ${rows}`)
  } else {
    console.log('матрицы нет: в проекте одна глава без связей?')
  }
  await browser.close()
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
