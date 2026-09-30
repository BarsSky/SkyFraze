// Фокусный тест: добавить события → logout → login → проверить восстановление
import { chromium, type BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const OUT = 'C:/tmp/skyfraze-shots'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost:5173'

async function shot(page: any, name: string) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true })
  console.log(`[shot] ${path.join(OUT, `${name}.png`)}`)
}

;(async () => {
  const browser = await chromium.launch()
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('yprovider') || t.includes('snapshot')) console.log(`[${m.type()}]`, t)
  })

  const ts = Date.now()
  const email = `restore-${ts}@e.com`

  // 1. Register
  await page.goto(`${BASE}/register`)
  await shot(page, '01-register')
  await page.fill('input[placeholder="имя"]', 'Restorer')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', 'hunter22!')
  await page.getByRole('button', { name: /Создать/ }).click()
  await page.waitForURL(/\/projects$/)

  // 2. Create project
  await page.getByRole('button', { name: /\+ Новый проект/ }).click()
  await page.fill('input[placeholder="Название"]', 'ReStore Test')
  await page.getByRole('button', { name: /^Создать$/ }).click()
  await page.waitForSelector('h3 a')
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(2000)
  await shot(page, '02-timeline-init')

  // 3. Add events
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: /\+ Событие/ }).click()
    await page.waitForTimeout(800)
    const editorInput = page.locator('section input[placeholder="Заголовок события"]').last()
    await editorInput.fill('')
    await editorInput.fill(`Акт ${i} — дракон просыпается`)
    const editorBody = page.locator('section textarea').last()
    await editorBody.fill(`Описание акта ${i} с подробностями сцены.`)
    await page.waitForTimeout(400)
  }

  // wait for debounced save
  await page.waitForTimeout(3000)
  await shot(page, '03-events-added')

  // Probe events count in doc
  const beforeCount = await page.evaluate(() => {
    const w: any = window
    return w.__yjsDoc?.getArray('events').length ?? -1
  })
  console.log('LOCAL doc events:', beforeCount)

  // 4. Logout
  await page.getByRole('button', { name: /Выйти|Logout/ }).click()
  await page.waitForURL(/\/login$/)
  await shot(page, '04-login')

  // 5. Login back
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', 'hunter22!')
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/)
  await shot(page, '05-back-to-projects')

  // 6. Reopen project
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(5000) // give snapshot time
  await shot(page, '06-reopen-after-login')

  // Probe doc state
  const afterCount = await page.evaluate(() => {
    const w: any = window
    return w.__yjsDoc?.getArray('events').length ?? -1
  })
  console.log('AFTER re-login doc events:', afterCount)

  // Look for event bodies text on the page
  const text = await page.locator('section').allTextContents()
  const titles = text.map((t: string) => t.split('\n')[0]?.trim()).filter(Boolean)
  console.log('section titles:', titles.slice(0, 6))

  // Check if edit-buttons present
  const editBtnCount = await page.locator('button:has-text("редактировать")').count()
  console.log('edit-buttons:', editBtnCount)

  await browser.close()
})().catch((e) => { console.error('FATAL', e); process.exit(1) })

