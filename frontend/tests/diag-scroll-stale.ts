// Гипотеза: при переходе на страницу проекта сохраняется прежняя прокрутка
// контейнера main, трек уезжает вверх, стадия уходит в idle — и на экране
// остаётся только фон (ни меню стадии, ни кнопки «Редакторы», ни чипов).
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const SIZE = process.env.VIEWPORT === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 }

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: SIZE,
  ...(process.env.VIEWPORT === 'desktop' ? {} : { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
})
const page = await ctx.newPage()
const logs: string[] = []
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message))

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('input[type=email]', 'galactic.test@e.com')
await page.fill('input[type=password]', 'hunter22!')
await page.click('button[type=submit]')
await page.waitForURL(/projects/, { timeout: 20000 })
await page.waitForSelector('.list .card', { timeout: 20000 })

const state = async (label: string) => {
  const info = (await page.evaluate(`(() => {
    const main = document.querySelector('.layout main')
    const root = document.querySelector('.sf-root')
    const vis = (s) => {
      const el = document.querySelector(s)
      if (!el) return 'нет'
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return cs.visibility + '/op' + Number(cs.opacity).toFixed(1) + '/y' + Math.round(r.y)
    }
    return {
      path: location.pathname,
      mainScrollTop: main ? Math.round(main.scrollTop) : null,
      mainScrollHeight: main ? Math.round(main.scrollHeight) : null,
      stage: root ? root.getAttribute('data-stage') : null,
      topbar: vis('.sf-topbar'),
      copylayer: vis('.sf-copylayer'),
      copy: vis('.sf-copy'),
      text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 90),
    }
  })()`)) as Record<string, unknown>
  console.log(`--- ${label}`)
  console.log(JSON.stringify(info, null, 1))
  return info
}

await state('сразу после входа в список проектов')

// Прокручиваем контейнер main (на телефоне это делается пальцем)
await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = 500; })()`)
await page.waitForTimeout(500)
await state('список проектов, main прокручен на 500')

// Открываем проект
await page.locator('.list .card h3 a').first().click()
await page.waitForURL(/\/projects\/[a-f0-9-]+$/, { timeout: 20000 })
await page.waitForTimeout(3500)
await state('страница проекта после перехода')

await page.screenshot({ path: `C:/Projects/SkyFraze/_mobile_diag/after-nav-${process.env.VIEWPORT ?? 'mobile'}.png` })
console.log('логи:', logs.slice(0, 4))

await browser.close()
