// Замер мобильных вьюпортов: не уезжают ли элементы стадии за пределы экрана,
// не перекрывают ли друг друга, помещается ли панель копирайта и её кнопки.
import { chromium } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.BASE_URL ?? 'http://192.168.13.20'
const OUT = 'C:/Projects/SkyFraze/_mobile_diag'
fs.mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { tag: 'iphone-se-1', w: 320, h: 568 }, // 4"
  { tag: 'iphone-se-2', w: 375, h: 667 }, // 4.7"
  { tag: 'android-small', w: 360, h: 640 }, // 5"
  { tag: 'iphone-12', w: 390, h: 844 }, // 6.1"
  { tag: 'landscape', w: 640, h: 360 },
]

const browser = await chromium.launch()
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type=email]', 'galactic.test@e.com')
  await page.fill('input[type=password]', 'hunter22!')
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 20000 })
  await page.locator('.list .card h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
  await page.waitForSelector('.sf-root', { timeout: 25000 })
  await page.waitForTimeout(2500)

  const report = (await page.evaluate(`(() => {
    const H = window.innerHeight, W = window.innerWidth
    const q = (s) => document.querySelector(s)
    const box = (s) => {
      const el = q(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        bottom: Math.round(r.bottom), right: Math.round(r.right),
        vis: cs.visibility, op: Number(cs.opacity),
        clipped: el.scrollHeight > el.clientHeight + 2,
        scrollH: el.scrollHeight, clientH: el.clientHeight,
      }
    }
    const items = {
      header: box('.layout header'),
      topbar: box('.sf-topbar'),
      chips: box('.sf-chips'),
      copy: box('.sf-copy'),
      hint: box('.sf-hint'),
      editorsBtn: box('.sf-topbar__actions'),
    }
    // элементы, вылезающие за вьюпорт
    const outside = Object.entries(items)
      .filter(([, b]) => b && b.vis === 'visible' && b.op > 0.05)
      .filter(([, b]) => b.y < -1 || b.bottom > H + 1 || b.x < -1 || b.right > W + 1)
      .map(([k, b]) => k + ': y' + b.y + '..' + b.bottom + ' (экран ' + H + ')')
    // попарные пересечения видимых слоёв
    const overlap = (a, b) => {
      if (!a || !b || a.vis !== 'visible' || b.vis !== 'visible' || a.op < 0.05 || b.op < 0.05) return 0
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x)
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
      return ox > 2 && oy > 2 ? Math.round(ox) + 'x' + Math.round(oy) : 0
    }
    const pairs = [
      ['header', 'topbar'], ['topbar', 'chips'], ['chips', 'copy'], ['copy', 'hint'], ['topbar', 'copy'],
    ].map(([a, b]) => ({ pair: a + '∩' + b, size: overlap(items[a], items[b]) })).filter((p) => p.size)

    // кнопки навигации внутри панели
    const nav = Array.from(document.querySelectorAll('.sf-copy__nav .sf-btn')).map((b) => {
      const r = b.getBoundingClientRect()
      return { text: (b.textContent || '').trim().slice(0, 14), y: Math.round(r.y), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= H }
    })
    return { H, W, items, outside, pairs, nav, stageFlag: q('.sf-root')?.getAttribute('data-stage') }
  })()`)) as Record<string, any>

  console.log(`\n=== ${vp.tag} (${vp.w}x${vp.h}) ===`)
  console.log('  stage:', report.stageFlag)
  for (const [k, b] of Object.entries(report.items as Record<string, { y: number; bottom: number; h: number; vis: string; op: number; clipped?: boolean; scrollH?: number; clientH?: number }>)) {
    if (!b) { console.log(`  ${k}: нет`); continue }
    console.log(`  ${k}: y${b.y}..${b.bottom} h${b.h} vis=${b.vis} op=${b.op}${b.clipped ? ` CLIPPED(scroll ${b.scrollH} > ${b.clientH})` : ''}`)
  }
  console.log('  вне экрана:', report.outside.length ? report.outside : 'нет')
  console.log('  пересечения:', report.pairs.length ? report.pairs : 'нет')
  console.log('  кнопки навигации:', JSON.stringify(report.nav))
  if (errors.length) console.log('  ошибки:', errors.slice(0, 2))

  await page.screenshot({ path: `${OUT}/vp-${vp.tag}.png` })
  await ctx.close()
}
await browser.close()
