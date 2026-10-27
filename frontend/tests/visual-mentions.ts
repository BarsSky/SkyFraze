/**
 * Живой инструмент: снимок упоминаний карточек в кадре (в CI не гоняется).
 * Запуск: npx tsx tests/visual-mentions.ts (backend :8181 и vite :5173 подняты,
 * в проекте уже есть карточки — их заводит tests/visual-entities.ts)
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

  // Кадр: в пустом проекте сначала создаём первую главу.
  const firstChapter = page.getByRole('button', { name: /Добавить первую главу/ })
  if (await firstChapter.isVisible().catch(() => false)) {
    await firstChapter.click()
    await page.waitForTimeout(1500)
  }
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 30_000 })

  // Текст с упоминаниями всех трёх карточек: «Анна», «Дом на холме», «Письмо».
  const body = page.locator('.ed-editor textarea').first()
  await body.waitFor({ state: 'visible', timeout: 20_000 })
  await body.click()
  await body.fill('Анна вошла в дом на холме. Она принесла письмо и долго молчала.')
  await page.waitForTimeout(1200)

  const mentions = page.locator('[data-frame-mentions]')
  await mentions.waitFor({ state: 'visible', timeout: 20_000 })
  await mentions.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await page.locator('[data-editor-panel]').screenshot({ path: 'visual-mentions.png' })

  // Клик по чипу должен выделить слово в тексте — это и есть «переход к упоминанию».
  const chip = mentions.locator('button').first()
  const label = (await chip.innerText()).replace(/\s+/g, ' ')
  await chip.click()
  await page.waitForTimeout(400)
  const selected = await body.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    return area.value.slice(area.selectionStart, area.selectionEnd)
  })
  console.log(`чип: ${label} → выделено в тексте: «${selected}»`)
  await page.screenshot({ path: 'visual-mentions-click.png' })

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
