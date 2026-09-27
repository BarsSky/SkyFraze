// Диагностика мобильного вида: что реально на странице проекта при 390×844.
import { chromium } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = 'C:/Projects/SkyFraze/_mobile_diag'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
const logs: string[] = []
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') logs.push('console: ' + m.text())
})

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('input[type=email]', 'galactic.test@e.com')
await page.fill('input[type=password]', 'hunter22!')
await page.click('button[type=submit]')
await page.waitForURL(/projects/, { timeout: 20000 })
await page.screenshot({ path: `${OUT}/1-projects.png` })

// Открываем первый проект из списка
await page.locator('.list .card h3 a').first().click()
await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
await page.waitForTimeout(4000)
await page.screenshot({ path: `${OUT}/2-project.png`, fullPage: false })

const info = (await page.evaluate(`(() => {
  const q = (s) => document.querySelector(s)
  const box = (s) => {
    const el = q(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position,
    }
  }
  const main = q('.layout main')
  // Кнопка «Редакторы»: не уехала ли под шапку и попадает ли по ней клик.
  const btn = Array.from(document.querySelectorAll('.sf-topbar__actions button, .sf-topbar__actions a'))
    .find((el) => /Редактор/i.test(el.textContent || ''))
  let hit = null
  let btnBox = null
  if (btn) {
    const r = btn.getBoundingClientRect()
    btnBox = { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    hit = top ? (btn.contains(top) ? 'сама кнопка' : top.className || top.tagName) : 'нет элемента'
  }
  return {
    url: location.pathname,
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
    headerVar: getComputedStyle(document.documentElement).getPropertyValue('--sf-header-h').trim(),
    scrollHeight: document.documentElement.scrollHeight,
    mainScrollTop: main ? main.scrollTop : null,
    mainScrollHeight: main ? main.scrollHeight : null,
    stageFlag: q('.sf-root') ? q('.sf-root').getAttribute('data-stage') : null,
    editorsButton: { box: btnBox, hit },
    boxes: {
      header: box('.layout header'),
      root: box('.sf-root'),
      topbar: box('.sf-topbar'),
      nav: box('.sf-topbar__actions'),
      copy: box('.sf-copy'),
      editors: box('[data-editor-panel]'),
    },
  }
})()`)) as Record<string, unknown>

console.log(JSON.stringify(info, null, 2))
console.log('логи:', logs.slice(0, 6))

// Что если проскроллить вниз (к редакторам)
await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = 700; })()`)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/3-scrolled.png` })
const after = (await page.evaluate(`(() => {
  const q = (s) => document.querySelector(s)
  const root = q('.sf-root')
  const box = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) } }
  return { stageFlag: root ? root.getAttribute('data-stage') : null, copy: box('.sf-copy'), editors: box('[data-editor-panel]') }
})()`)) as unknown
console.log('после скролла:', JSON.stringify(after))

await browser.close()
