/**
 * Живой инструмент: хронология карточки и фильтр дерева (0.69.0, в CI не гоняется).
 * Запуск: npx tsx tests/visual-chronology.ts (backend :8181 и vite :5173 подняты)
 */
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

  const firstChapter = page.getByRole('button', { name: /Добавить первую главу/ })
  if (await firstChapter.isVisible().catch(() => false)) {
    await firstChapter.click()
    await page.waitForTimeout(1500)
  }
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 30_000 })

  // Текст с датой и без: хронология должна поставить кадр с датой первым.
  const body = page.locator('.ed-editor textarea').first()
  await body.waitFor({ state: 'visible', timeout: 20_000 })
  await body.click()
  await body.fill('Анна вошла в дом на холме. Она принесла письмо.')
  const date = page.locator('input[type="date"]').first()
  if (await date.count()) {
    await date.fill('2026-03-02')
    await date.blur()
  }
  await page.waitForTimeout(1200)

  // Раскрываем «Связи проекта» и хронологию первой карточки.
  await page.locator('[data-entities] summary').click()
  const chronology = page.getByLabel(/Где встречается/)
  if (await chronology.count()) {
    await chronology.first().click()
    await page.waitForTimeout(500)
  }
  await page.locator('[data-entities]').screenshot({ path: 'visual-chronology.png' })

  // Фильтр дерева по карточке.
  const filter = page.locator('[data-ed-entity-filter]')
  if (await filter.count()) {
    const options = await filter.locator('option').allTextContents()
    const target = options.find((label) => label.includes('Анна')) ?? options[1]
    await filter.selectOption({ label: target })
    await page.waitForTimeout(600)
    const rows = await page.locator('.ed-row').count()
    console.log(`фильтр «${target}»: строк в дереве ${rows} (карточек: ${options.length - 1})`)
    await page.locator('[data-editor-panel]').screenshot({ path: 'visual-tree-filter.png' })
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
