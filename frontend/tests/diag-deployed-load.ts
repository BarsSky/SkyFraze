/**
 * Скорость РАЗВЁРНУТОГО стенда (0.80.0): холодная и повторная загрузка.
 *
 * Отвечает на вопрос «почему у меня долго грузится» числами с боевого адреса, а не с локальной
 * сборки: задержка до сервера, блокирующие ресурсы, кеш. Первый прогон — с пустым кешем (как у
 * нового посетителя), второй — с тем, что уже скачано (как при обычной перезагрузке).
 *
 * Запуск: cd frontend && npx tsx tests/diag-deployed-load.ts [URL]
 */
import { chromium, type Page } from 'playwright'

const BASE = process.argv[2] ?? process.env.DEPLOY_URL ?? 'https://fraze.skynas.ru'

interface LoadResult {
  label: string
  readyMs: number
  marks: Record<string, number>
  paints: Record<string, number>
  resources: number
  fromCache: number
}

async function measure(page: Page, label: string): Promise<LoadResult> {
  // Строкой, а не функцией: tsx добавляет в функции обёртку `__name`, которой в браузере нет.
  await page.addInitScript(`
    (function () {
      var marks = {}
      var start = performance.now()
      function tick() {
        if (marks.boot === undefined && document.querySelector('[data-boot]')) marks.boot = Math.round(performance.now() - start)
        if (marks.form === undefined && document.querySelector('input[type="password"]')) marks.form = Math.round(performance.now() - start)
        if (performance.now() - start < 30000) setTimeout(tick, 40)
      }
      tick()
      window.__marks = marks
    })()
  `)
  const started = Date.now()
  await page.goto(`${BASE}/login`, { waitUntil: 'commit' })
  await page
    .locator('input[type="password"]')
    .waitFor({ state: 'visible', timeout: 60_000 })
    .catch(() => undefined)
  const readyMs = Date.now() - started
  await page.waitForTimeout(1500)
  const data = (await page.evaluate(`(async () => {
    var paints = {}
    performance.getEntriesByType('paint').forEach(function (e) { paints[e.name] = Math.round(e.startTime) })
    var res = performance.getEntriesByType('resource')
    var fromCache = res.filter(function (r) { return r.transferSize === 0 && r.decodedBodySize > 0 }).length
    return { marks: window.__marks, paints: paints, resources: res.length, fromCache: fromCache }
  })()`)) as Omit<LoadResult, 'label' | 'readyMs'>
  return { label, readyMs, ...data }
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  // Сеть и CPU как у телефона: на быстром канале разница не видна.
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
    uploadThroughput: Math.round((750 * 1024) / 8),
  })
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })

  const cold = await measure(page, 'первый (кеш пуст)')
  const warm = await measure(page, 'повторный (кеш есть)')
  console.log(JSON.stringify({ base: BASE, cold, warm }, null, 2))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
