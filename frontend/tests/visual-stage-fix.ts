/**
 * Живой инструмент: шапка приложения и полоска сцены после ухода к редакторам и возврата
 * (0.72.1, в CI не гоняется).
 *
 * Проверяет ту самую ошибку: scrollIntoView двигал документ на высоту шапки, а вернуть её
 * было нечем — прокрутка документа запрещена. Здесь видно docScroll и headerY: правильные
 * значения — 0 и 0.
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'visual.entities@example.com'
const PASSWORD = 'hunter22!'

async function check(page: Page, label: string) {
  const stage = await page.locator('.sf-root').getAttribute('data-stage').catch(() => null)
  const topbar = await page.locator('.sf-topbar').evaluate((el) => getComputedStyle(el).opacity).catch(() => 'n/a')
  const header = await page.locator('.layout > header').first().isVisible()
  console.log(`${label}: stage=${stage} topbar=${topbar} header=${header}`)
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(1000)
  await page.locator('a[href*="/projects/"]').first().click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await page.locator('[data-editor-panel]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(600)
  await check(page, 'старт')

  // Кнопка «связи проекта» в тулбаре: раскрывает блок и прокручивает к нему.
  await page.locator('[data-ed-entities-jump]').click()
  await page.waitForTimeout(900)
  await check(page, 'после «связи проекта»')
  const open = await page.locator('[data-entities]').evaluate((el) => (el as HTMLDetailsElement).open)
  console.log('блок связей раскрыт:', open)

  await page.locator('[data-editor-panel]').scrollIntoViewIfNeeded()
  await page.waitForTimeout(700)
  await check(page, 'у редакторов')
  await page.locator('.sf-root').scrollIntoViewIfNeeded()
  await page.waitForTimeout(700)
  await check(page, 'вернулись к сцене')
  const geom = await page.evaluate(() => {
    const header = document.querySelector('.layout > header')
    const main = document.querySelector('main')
    return {
      winScroll: Math.round(window.scrollY),
      docScroll: Math.round(document.documentElement.scrollTop),
      bodyScroll: Math.round(document.body.scrollTop),
      mainScroll: main ? Math.round(main.scrollTop) : -1,
      headerY: header ? Math.round(header.getBoundingClientRect().y) : null,
      headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
      layoutH: Math.round(document.querySelector('.layout')!.getBoundingClientRect().height),
      docH: document.documentElement.scrollHeight,
    }
  })
  console.log('геометрия:', JSON.stringify(geom))
  await page.screenshot({ path: 'fix-stage.png' })
  await browser.close()
}

void main().catch((error) => { console.error(error); process.exit(1) })
