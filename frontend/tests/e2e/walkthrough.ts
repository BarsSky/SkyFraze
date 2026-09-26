// Скрипт проходит по всему UI: register → projects → timeline → settings → assets upload → team invite → logout → login.
// Снимает скриншоты на desktop (1440x900), tablet (768x1024) и mobile (390x844).
// Запуск: npx tsx tests/e2e/walkthrough.ts

import { chromium, type Page, type BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const OUT = 'C:/tmp/skyfraze-shots'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost:5173'

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400)
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`[shot] ${file}`)
}

async function bodyOverflows(page: Page, label: string): Promise<any[]> {
  return await page.evaluate((l: string) => {
    const docW = document.documentElement.clientWidth
    const out: Array<{ tag: string; cls: string; text: string; scroll: number }> = []
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.right > docW + 1 && el.children.length <= 2) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className as string) || '',
          text: (el.innerText || '').slice(0, 80),
          scroll: Math.round(r.right - docW),
        })
      }
    })
    if (out.length) console.log(`[overflow-${l}]`, JSON.stringify(out.slice(0, 10), null, 2))
    return out.slice(0, 20)
  }, label)
}

async function fullWalk(context: BrowserContext, tag: string): Promise<{ errors: string[]; overflows: any[] }> {
  const page = await context.newPage()

  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  const ts = Date.now()
  const email = `e2e-${tag}-${ts}@example.com`

  // 1. register
  await page.goto(`${BASE}/register`)
  await shot(page, `${tag}-01-register`)
  await page.fill('input[placeholder="имя"]', 'E2E User')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', 'hunter22!')
  await page.getByRole('button', { name: /Создать/ }).click()
  await page.waitForURL(/\/projects$/)
  await shot(page, `${tag}-02-projects-empty`)

  // 2. create project
  await page.getByRole('button', { name: /\+ Новый проект/ }).click()
  await page.fill('input[placeholder="Название"]', 'Эпос про дракона')
  await page.fill('textarea', 'Сюжет: герой встречает дракона в горах.')
  await page.getByRole('button', { name: /^Создать$/ }).click()
  await page.waitForSelector('h3 a', { timeout: 5000 })
  await shot(page, `${tag}-03-projects-with-one`)

  // 3. open timeline
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(1500)
  await shot(page, `${tag}-04-timeline-init`)

  // 4. add 3 events — wait between, title/body via Yjs-binded inputs
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: /\+ Событие/ }).click()
    await page.waitForTimeout(500)
    const editorInput = page.locator('section input[placeholder="Заголовок события"]').last()
    await editorInput.fill('')
    await editorInput.fill(`Событие ${i}`)
    const editorBody = page.locator('section textarea').last()
    await editorBody.fill(`Описание события номер ${i}.\nДетали поворота сюжета.`)
    await page.waitForTimeout(200)
    await shot(page, `${tag}-05-ev-${i}`)
  }

  // 5. scroll the timeline (scrub input)
  await page.evaluate(() => window.scrollTo({ top: 800 }))
  await page.waitForTimeout(500)
  await shot(page, `${tag}-06-timeline-scrolled`)

  await page.evaluate(() => window.scrollTo({ top: 1800 }))
  await page.waitForTimeout(500)
  await shot(page, `${tag}-07-timeline-scrolled-more`)

  // 6. settings + invite
  await page.evaluate(() => window.scrollTo({ top: 0 }))
  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1] ?? ''
  await page.goto(`${BASE}/projects/${projectId}/settings`)
  await page.waitForTimeout(800)
  await shot(page, `${tag}-08-settings-empty`)

  // wait for ready (RequireAuth shows "Загрузка…" briefly)
  await page.waitForSelector('input[placeholder="email@example.com"]', { timeout: 10000 })
  await page.fill('input[placeholder="email@example.com"]', `invitee-${ts}@example.com`)
  await page.locator('button[type="submit"]').filter({ hasText: 'Отправить' }).click()
  await page.waitForTimeout(1000)
  await shot(page, `${tag}-09-settings-invite-sent`)

  // 7. logout
  await page.getByRole('button', { name: /Logout/ }).click()
  await page.waitForURL(/\/login$/)
  await shot(page, `${tag}-10-login`)

  // 8. login
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', 'hunter22!')
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/)
  await shot(page, `${tag}-11-login-back`)

  // 9. timeline + asset upload
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  // ждём, пока Yjs восстановит события (они сохранены в БД из предыдущей сессии)
  try {
    await page.waitForSelector('button:has-text("редактировать")', { timeout: 20000 })
  } catch {
    console.log(`[warn-${tag}] no edit-buttons after re-login — события не восстановились из snapshot`)
  }
  const editBtn = page.locator('button:has-text("редактировать")').first()
  if ((await editBtn.count()) > 0) {
    await editBtn.click()
  } else {
    // иначе добавляем новое событие и открываем его редактор
    await page.getByRole('button', { name: /\+ Событие/ }).click()
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(400)
  await shot(page, `${tag}-12-event-edit`)

  const fakePng = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000192d8a2a40000000049454e44ae426082',
    'hex'
  )
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sketch.png', mimeType: 'image/png', buffer: fakePng,
  })
  await page.waitForTimeout(1200)
  await shot(page, `${tag}-13-asset-uploaded`)

  // 10. overflow audit
  const overflows = await bodyOverflows(page, tag)

  await page.close()
  return { errors, overflows }
}

;(async () => {
  const viewports = [
    { width: 1440, height: 900, tag: 'desktop' },
    { width: 768, height: 1024, tag: 'tablet' },
    { width: 390, height: 844, tag: 'mobile' },
  ]

  let totalErrors = 0
  let totalOverflows = 0

  for (const vp of viewports) {
    console.log(`\n=== ${vp.tag} ${vp.width}x${vp.height} ===`)
    const browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    })
    try {
      const { errors, overflows } = await fullWalk(context, vp.tag)
      totalErrors += errors.length
      totalOverflows += overflows.length
      if (errors.length) {
        console.log(`[errors-${vp.tag}]`)
        errors.forEach((e) => console.log('  ', e))
      } else {
        console.log(`[errors-${vp.tag}] clean`)
      }
    } finally {
      await context.close()
      await browser.close()
    }
  }

  console.log('\n========== SUMMARY ==========')
  console.log(`Total console errors: ${totalErrors}`)
  console.log(`Total terminal overflows: ${totalOverflows}`)
})().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
