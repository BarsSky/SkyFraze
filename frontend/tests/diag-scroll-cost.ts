/**
 * Сколько стоит прокрутка на телефоне и что её тормозит (0.77.2).
 *
 * Гипотеза: полноэкранная сцена с `will-change: transform` и размытия (`backdrop-filter`)
 * на закреплённой шапке заставляют GPU пересчитывать блюр каждый кадр. Проверяем A/B:
 * тот же жест пальцем с размытиями и без них, при замедлении CPU вчетверо (как на телефоне
 * среднего класса).
 *
 * Запуск: cd frontend && npx tsx tests/diag-scroll-cost.ts
 */
import { chromium, type CDPSession, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

/** Жест пальцем на 400 px; возвращает кадры, время и число кадров с задержкой > 32 мс. */
async function gesture(page: Page, client: CDPSession) {
  await evalIn(
    page,
    `
    window.__frames = 0
    window.__slow = 0
    window.__last = performance.now()
    window.__running = true
    var tick = function (now) {
      if (!window.__running) return
      window.__frames += 1
      if (now - window.__last > 32) window.__slow += 1
      window.__last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return true
    `,
  )
  const start = Date.now()
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 600 }] })
  for (let step = 1; step <= 20; step += 1) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 180, y: 600 - step * 20 }],
    })
    await page.waitForTimeout(30)
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const elapsed = Date.now() - start
  await page.waitForTimeout(250)
  const result = await evalIn<{ frames: number; slow: number; scrolled: number }>(
    page,
    `
    window.__running = false
    var main = document.querySelector('main')
    return { frames: window.__frames, slow: window.__slow, scrolled: Math.round(main.scrollTop) }
    `,
  )
  return { ...result, elapsed, fps: Number((result.frames / (elapsed / 1000)).toFixed(1)) }
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-stage], .sf-stage').first().waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(2000)

  const client = await page.context().newCDPSession(page)
  // Телефон среднего класса: замедляем CPU вчетверо, иначе на десктопе всё летает.
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  const withFix = await gesture(page, client)

  // Возвращаем размытия принудительно: так видно, что именно они стоили кадров, и что фикс
  // (выключение blur на узком экране) действительно работает, а не «стало казаться».
  await page.addStyleTag({
    content:
      '.layout header, .sf-topbar, .sf-nav, .sf-route, .sf-copy, .sf-chip, .ai-window { backdrop-filter: blur(10px) !important; -webkit-backdrop-filter: blur(10px) !important; }',
  })
  await page.waitForTimeout(500)
  const withBlur = await gesture(page, client)

  console.log(
    JSON.stringify(
      {
        withFix,
        withBlur,
        slowFrames: { withFix: withFix.slow, withBlur: withBlur.slow },
        frames: { withFix: withFix.frames, withBlur: withBlur.frames },
      },
      null,
      2,
    ),
  )
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
