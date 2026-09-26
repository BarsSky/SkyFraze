// Diag: добавить событие, дождаться save, проверить через /state
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  page.on('console', (m) => console.log(`[browser ${m.type()}]`, m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  page.on('response', async (r) => {
    const u = r.url()
    if (u.includes('events/state') || u.includes('api/projects')) {
      console.log(`[${r.request().method()} ${r.status()}]`, u.split('/').slice(-2).join('/'))
    }
  })

  const email = `diag-persist-${Date.now()}@e.com`
  await page.goto('http://localhost:5173/register')
  await page.fill('input[placeholder="имя"]', 'P')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', 'hunter22!')
  await page.getByRole('button', { name: /Создать/ }).click()
  await page.waitForURL(/\/projects$/)
  await page.getByRole('button', { name: /\+ Новый проект/ }).click()
  await page.fill('input[placeholder="Название"]', 'persist')
  await page.getByRole('button', { name: /^Создать$/ }).click()
  await page.waitForSelector('h3 a')
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(2000)

  // Add 1 event
  await page.getByRole('button', { name: /\+ Событие/ }).click()
  await page.waitForTimeout(1500)

  // Probe state directly via fetch
  const stateBytes = await page.evaluate(async () => {
    const tokens = JSON.parse(localStorage.getItem('skyfraze-auth') ?? '{}')
    const access = tokens?.state?.accessToken ?? null
    const m = location.pathname.match(/\/projects\/([^/]+)/)
    const projId = m?.[1]
    const r = await fetch(`/api/projects/${projId}/events/state`, {
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/octet-stream' },
    })
    if (!r.ok) return { status: r.status, length: 0 }
    const buf = await r.arrayBuffer()
    return { status: r.status, length: buf.byteLength }
  })
  console.log('[probe state]', JSON.stringify(stateBytes))

  await browser.close()
}

main().catch(console.error)
