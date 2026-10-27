/**
 * Пустая полоса между показом проекта (стадией) и разделом «Связи» (0.82.0).
 *
 * Метрика: для каждой прокрутки считаем, сколько пикселей экрана НАД разделом пусто при уже
 * погашенной стадии. Именно это человек видит как «слишком много места при прокрутке»: сцена
 * исчезла, а раздел ещё не дошёл, и между ними — фон страницы.
 *
 * Запуск: cd frontend && npx tsx tests/diag-gap.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-relations]').waitFor({ state: 'visible', timeout: 45_000 })
  await page.waitForTimeout(1500)

  const result = (await page.evaluate(`(async () => {
    var main = document.querySelector('main')
    var rel = document.querySelector('[data-relations]')
    var root = document.querySelector('.sf-root')
    var stage = document.querySelector('.sf-stage')
    var max = main.scrollHeight - main.clientHeight
    var worst = { gap: 0, scroll: 0, relTop: 0 }
    var samples = []
    var idleFrom = null
    for (var top = 0; top <= max; top += 120) {
      main.scrollTop = top
      await new Promise(function (r) { setTimeout(r, 45) })
      var state = root ? root.getAttribute('data-stage') : 'none'
      var hidden = stage ? getComputedStyle(stage).visibility === 'hidden' : false
      var relTop = Math.round(rel.getBoundingClientRect().top)
      var gap = hidden && relTop > 0 ? relTop : 0
      if (hidden && idleFrom === null) idleFrom = top
      if (gap > worst.gap) worst = { gap: gap, scroll: top, relTop: relTop }
      if (top % 300 === 0) samples.push({ scroll: top, state: state, hidden: hidden, relTop: relTop, gap: gap })
    }
    return {
      viewport: window.innerHeight,
      maxScroll: max,
      idleFromScroll: idleFrom,
      worst: worst,
      samples: samples,
    }
  })()`)) as Record<string, unknown>

  console.log(JSON.stringify(result, null, 2))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
