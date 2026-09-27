// Проверка на НЕзащищённом origin (http://IP, как на телефоне):
// доступен ли crypto.randomUUID и что происходит при открытии проекта
// и при попытке редактирования (создание главы/подсобытия).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://192.168.13.20'
console.log('origin:', BASE, '(secure context =', BASE.startsWith('https://') || BASE.includes('localhost'), ')')

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const logs: string[] = []
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') logs.push('console: ' + m.text().slice(0, 160))
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('input[type=email]', 'galactic.test@e.com')
await page.fill('input[type=password]', 'hunter22!')
await page.click('button[type=submit]')
await page.waitForURL(/projects/, { timeout: 20000 })

const api = (await page.evaluate(`!!(window.crypto && window.crypto.randomUUID)`)) as boolean
console.log('crypto.randomUUID доступен:', api)
const secure = (await page.evaluate(`window.isSecureContext`)) as boolean
console.log('isSecureContext:', secure)

// Открываем пустой проект (создаём через UI), чтобы пройти путь «нет событий»
await page.click('button:has-text("+ Новый проект")')
await page.fill('input[placeholder="Название"]', `Secure ${Date.now()}`)
await page.click('button:has-text("Создать")')
await page.waitForSelector('.list .card', { timeout: 15000 })
await page.locator('.list .card h3 a').first().click()
await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
await page.waitForTimeout(2500)

const empty = (await page.evaluate(`(() => {
  const b = document.body.innerText.replace(/\\s+/g, ' ')
  return { text: b.slice(0, 120), hasEmptyState: !!document.querySelector('.sf-empty'), hasStage: !!document.querySelector('.sf-root'), header: !!document.querySelector('.layout header') }
})()`)) as Record<string, unknown>
console.log('пустой проект:', JSON.stringify(empty))

// Пытаемся создать первую главу — здесь вызывается crypto.randomUUID
const button = page.locator('button:has-text("+ Добавить первую главу")')
if (await button.count()) {
  await button.click()
  await page.waitForTimeout(2000)
  const after = (await page.evaluate(`(() => {
    const b = document.body.innerText.replace(/\\s+/g, ' ')
    return { text: b.slice(0, 140), hasStage: !!document.querySelector('.sf-root'), editors: !!document.querySelector('[data-editor-panel]') }
  })()`)) as Record<string, unknown>
  console.log('после «+ Добавить первую главу»:', JSON.stringify(after))
  await page.screenshot({ path: 'C:/Projects/SkyFraze/_mobile_diag/insecure-create.png' })
} else {
  console.log('кнопки создания главы нет')
}

console.log('логи:', logs.slice(0, 5))
await browser.close()
