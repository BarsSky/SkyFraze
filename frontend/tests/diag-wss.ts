// Почему не поднимается realtime через TLS-прокси: слушаем ошибку сокета и
// смотрим состояние соединения изнутри приложения.
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'https://fraza.localtest.me:8443'

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  ignoreHTTPSErrors: true,
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()
page.on('console', (m) => console.log(`  [console:${m.type()}]`, m.text().slice(0, 200)))
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)))
page.on('websocket', (ws) => {
  console.log('  [ws] открыт:', ws.url().slice(0, 80))
  ws.on('socketerror', (err) => console.log('  [ws] ошибка сокета:', String(err)))
  ws.on('close', () => console.log('  [ws] закрыт'))
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('input[type=email]', 'galactic.test@e.com')
await page.fill('input[type=password]', 'hunter22!')
await page.click('button[type=submit]')
await page.waitForURL(/projects/, { timeout: 20000 })
await page.locator('.list .card h3 a').first().click()
await page.waitForSelector('.sf-root', { timeout: 25000 })
await page.waitForTimeout(5000)

const state = (await page.evaluate(`(() => {
  const note = Array.from(document.querySelectorAll('.ed-note, [data-sync-note], .ed-panel p')).map((e) => e.textContent.trim()).filter(Boolean)
  return { text: note.slice(0, 3), wsState: window.__yjsDoc ? 'doc есть' : 'doc нет' }
})()`)) as Record<string, unknown>
console.log('  состояние:', JSON.stringify(state))
await browser.close()
