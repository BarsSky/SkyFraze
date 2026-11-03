/**
 * Живая проверка возобновления бесед с помощником (0.147.0).
 *
 * Проверяем путь человека, а не код:
 *  1. окно открывает последнюю беседу проекта (в переписке есть реплики);
 *  2. после ПЕРЕЗАГРУЗКИ страницы переписка на месте (беседа берётся с сервера);
 *  3. «История» показывает список бесед проекта и открывает другую беседу;
 *  4. «Новый» очищает окно и снимает подсказку последней беседы.
 *
 * Запуск (стенд):
 *   cd frontend
 *   $env:VISUAL_BASE_URL='https://fraze.skynas.ru'; $env:TOKEN=...; $env:REFRESH=...
 *   $env:PROJECT_ID='7fec44b0-…'; npx tsx tests/diag-assistant-restore.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'https://fraze.skynas.ru'
const TOKEN = process.env.TOKEN ?? ''
const REFRESH = process.env.REFRESH ?? ''
const PROJECT_ID = process.env.PROJECT_ID ?? ''
const SHOTS = process.env.SHOTS ?? '..\\_dev_shots'

const findings: Array<{ level: 'error' | 'warning' | 'info'; what: string }> = []
const add = (level: 'error' | 'warning' | 'info', what: string) => findings.push({ level, what })

async function main() {
  if (!TOKEN || !REFRESH || !PROJECT_ID) {
    console.error('нужны TOKEN, REFRESH и PROJECT_ID')
    process.exit(1)
  }
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(
    `localStorage.setItem('skyfraze-auth', ${JSON.stringify(
      JSON.stringify({
        state: { accessToken: TOKEN, refreshToken: REFRESH, user: null, ready: false },
        version: 0,
      }),
    )})`,
  )
  const page = await context.newPage()
  page.on('pageerror', (err) => add('error', `pageerror: ${err.message}`))

  const openDock = async () => {
    const openButton = page.getByRole('button', { name: 'Открыть помощника' })
    if (await openButton.count()) await openButton.click()
    await page.locator('[data-assistant-panel]').waitFor({ state: 'visible', timeout: 15_000 })
  }
  const thread = async () => {
    await page.waitForTimeout(1500)
    return page.evaluate(() => ({
      count: document.querySelectorAll('[data-assistant-log] .ai-msg').length,
      first: (document.querySelector('[data-assistant-log] .ai-msg .ai-msg__text')?.textContent ?? '').trim().slice(0, 80),
      saved: localStorage.getItem('sf-ai-last:' + new URL(location.href).pathname.split('/').pop()),
      historyItems: document.querySelectorAll('[data-assistant-conversation]').length,
    }))
  }

  await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  if (page.url().includes('/login')) {
    await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
  }
  await openDock()

  const first = await thread()
  add('info', `при открытии: плашек ${first.count}, подсказка ${first.saved ?? '—'}`)
  if (first.count === 0) add('error', 'переписка не восстановилась при открытии проекта')
  await page.screenshot({ path: `${SHOTS}\\restore-1-open.png` })

  // 2. Перезагрузка страницы: беседа должна вернуться с сервера.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await openDock()
  const second = await thread()
  add('info', `после перезагрузки: плашек ${second.count}, первая реплика «${second.first.slice(0, 40)}»`)
  if (second.count === 0) add('error', 'после перезагрузки переписка пустая — возобновления нет')
  if (first.count > 0 && second.count !== first.count) {
    add('warning', `число плашек разошлось: было ${first.count}, стало ${second.count}`)
  }
  await page.screenshot({ path: `${SHOTS}\\restore-2-reload.png` })

  // 3. История: список бесед и переключение.
  const historyButton = page.locator('[data-assistant-history-button]')
  if ((await historyButton.count()) === 0) {
    add('warning', 'кнопки «История» нет — бесед в проекте меньше двух?')
  } else {
    await historyButton.click()
    await page.waitForTimeout(600)
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-assistant-conversation]')).map((item) => ({
        id: item.getAttribute('data-assistant-conversation'),
        title: (item.querySelector('.ai-history__title')?.textContent ?? '').trim(),
        current: item.getAttribute('aria-current') === 'true',
      })),
    )
    add('info', `история: бесед ${items.length}, текущая ${items.find((i) => i.current)?.title ?? '—'}`)
    if (items.length < 2) add('warning', 'в истории меньше двух бесед — переключение не проверить')
    await page.screenshot({ path: `${SHOTS}\\restore-3-history.png` })

    const other = items.find((item) => !item.current)
    if (other) {
      await page.locator(`[data-assistant-conversation="${other.id}"]`).click()
      const third = await thread()
      add('info', `открыта другая беседа «${other.title}»: плашек ${third.count}, подсказка ${third.saved ?? '—'}`)
      if (third.count === 0) add('error', 'другая беседа открылась пустой')
      if (third.saved !== other.id) add('warning', `подсказка не переключилась: ${third.saved} вместо ${other.id}`)
      await page.screenshot({ path: `${SHOTS}\\restore-4-other.png` })
    }
  }

  // 4. «Новый»: окно чистое, подсказка снята.
  await page.getByRole('button', { name: 'Новый' }).click()
  await page.waitForTimeout(600)
  const fourth = await thread()
  add('info', `после «Новый»: плашек ${fourth.count}, подсказка ${fourth.saved ?? '—'}`)
  if (fourth.count !== 0) add('error', '«Новый» не очистил переписку')
  if (fourth.saved !== null) add('error', '«Новый» не снял подсказку последней беседы')

  const order = { error: 0, warning: 1, info: 2 }
  findings.sort((a, b) => order[a.level] - order[b.level])
  console.log('')
  for (const finding of findings) console.log(`[${finding.level}] ${finding.what}`)
  const errors = findings.filter((f) => f.level === 'error').length
  console.log(`\nошибок: ${errors}, предупреждений: ${findings.filter((f) => f.level === 'warning').length}`)
  console.log(`скриншоты: ${SHOTS}\\restore-1-open.png … restore-4-other.png`)
  await browser.close()
  if (errors > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
