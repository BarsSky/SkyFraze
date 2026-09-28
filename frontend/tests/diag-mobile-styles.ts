// Почему на маленьком экране панель копирайта и подсказка оказываются не там:
// смотрим вычисленные top/bottom/max-height и ищем предка, который ломает
// привязку fixed/absolute (transform, filter, will-change, contain, perspective).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://192.168.13.20'

const browser = await chromium.launch()
for (const vp of [
  { tag: 'se1', w: 320, h: 568 },
  { tag: 'landscape', w: 640, h: 360 },
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('input[type=email]', 'galactic.test@e.com')
  await page.fill('input[type=password]', 'hunter22!')
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 20000 })
  await page.locator('.list .card h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
  await page.waitForSelector('.sf-root', { timeout: 25000 })
  await page.waitForTimeout(2000)

  const info = (await page.evaluate(`(() => {
    const dump = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return { sel, missing: true }
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      // ближайший предок, создающий containing block для fixed/absolute
      let culprit = null
      let cur = el.parentElement
      while (cur && cur !== document.documentElement) {
        const p = getComputedStyle(cur)
        if (p.transform !== 'none' || p.filter !== 'none' || p.perspective !== 'none' ||
            p.willChange !== 'auto' || p.contain !== 'none' || p.backdropFilter !== 'none') {
          culprit = (cur.className || cur.tagName) + ' {transform:' + p.transform + ' will-change:' + p.willChange + ' filter:' + p.filter + ' contain:' + p.contain + '}'
          break
        }
        cur = cur.parentElement
      }
      return {
        sel,
        position: cs.position,
        top: cs.top, bottom: cs.bottom, height: cs.height, maxHeight: cs.maxHeight,
        rectY: Math.round(r.y), rectBottom: Math.round(r.bottom), rectH: Math.round(r.height),
        ancestorBreakingFixed: culprit,
      }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      headerVar: getComputedStyle(document.documentElement).getPropertyValue('--sf-header-h').trim(),
      copy: dump('.sf-copy'),
      copylayer: dump('.sf-copylayer'),
      hint: dump('.sf-hint'),
      chips: dump('.sf-chips'),
      header: dump('.layout header'),
    }
  })()`)) as Record<string, any>

  console.log(`\n=== ${vp.tag} ${vp.w}x${vp.h} ===`)
  console.log('--sf-header-h:', info.headerVar, 'viewport:', JSON.stringify(info.viewport))
  for (const key of ['header', 'chips', 'copylayer', 'copy', 'hint']) {
    const d = info[key]
    if (!d || d.missing) { console.log(` ${key}: нет`); continue }
    console.log(` ${key}: position=${d.position} top=${d.top} bottom=${d.bottom} height=${d.height} maxHeight=${d.maxHeight}`)
    console.log(`    rect y${d.rectY}..${d.rectBottom} (h${d.rectH})`)
    if (d.ancestorBreakingFixed) console.log(`    предок, ломающий привязку: ${d.ancestorBreakingFixed}`)
  }
  await ctx.close()
}
await browser.close()
