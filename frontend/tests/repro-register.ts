// Воспроизводим проблему пользователя: открываем http://localhost,
// заполняем форму регистрации как у пользователя, кликаем "Создать",
// смотрим что показывает браузер.
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()

  page.on('console', (m) => console.log(`[${m.type()}]`, m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('requestfailed', (r) => console.log('[reqfail]', r.method(), r.url(), r.failure()?.errorText))
  page.on('response', async (r) => {
    const u = r.url()
    if (u.includes('/api/')) console.log(`[${r.status()}]`, r.request().method(), u.split('localhost').pop())
  })

  await page.goto('http://localhost/register')
  await page.waitForLoadState('networkidle')

  // Заполняем как у пользователя
  await page.fill('input[placeholder="имя"]', 'BarsSky')
  await page.fill('input[type="email"]', 'knagaenko@mail.ru')
  await page.fill('input[type="password"]', 'hunter22!')
  await page.screenshot({ path: 'C:/tmp/register-before.png' })
  console.log('--- click Создать ---')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'C:/tmp/register-after.png' })

  // URL сейчас
  console.log('current URL:', page.url())
  // Текст ошибки на странице
  const errText = await page.locator('.error').textContent().catch(() => '(no .error)')
  console.log('error text on page:', errText)

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
