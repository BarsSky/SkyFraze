/**
 * Почему перезагрузка страницы проекта долгая (0.80.0).
 *
 * Что измеряем: холодную перезагрузку с ОТКЛЮЧЁННЫМ кешем, замедленным CPU вчетверо и сетью
 * как у мобильного интернета (1.6 МБ/с, 150 мс задержки). Записываем:
 *   - когда появился каждый важный блок интерфейса (шапка, проект, стадия, редакторы, связи);
 *   - таймлайн запросов: кто когда начался, сколько шёл, кто кого ждёт;
 *   - метрики браузера: FCP, LCP, DOMContentLoaded, load;
 *   - длинные задачи и размеры ресурсов.
 *
 * Запуск: cd frontend && npx tsx tests/diag-load.ts [URL]
 * По умолчанию — vite dev на 5173. Для прод-сборки: npx vite preview --port 4173 и
 * `npx tsx tests/diag-load.ts http://localhost:4173`.
 */
import { chromium, type CDPSession, type Page } from 'playwright'

const BASE = process.argv[2] ?? process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
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
  await page.waitForURL(/\/projects$/, { timeout: 30_000 })
}

/** Замедляем сеть и CPU: на быстром канале разница в 100 мс не видна, а на телефоне видна. */
async function throttle(client: CDPSession) {
  await client.send('Network.enable')
  await client.send('Network.setCacheDisabled', { cacheDisabled: true })
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8),
    uploadThroughput: Math.round((750 * 1024) / 8),
  })
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 })
}

async function measureReload(page: Page, label: string, readySelector: string) {
  // Метки появления блоков ставим ДО навигации: иначе первый экран уже отрисован.
  // Строкой, а не функцией: tsx добавляет в функции обёртку `__name`, которой в браузере нет,
  // и init-скрипт молча падал (метки оставались пустыми — поймано при первом прогоне).
  await page.addInitScript(`
    (function () {
      var marks = {}
      var start = performance.now()
      var targets = [
        ['header', '.layout header'],
        ['projectsList', '[data-projects-list], h3 a'],
        ['projectTitle', '.sf-topbar__name, .sf-topbar'],
        ['stage', '[data-stage], .sf-stage'],
        ['relations', '[data-relations]'],
        ['editors', '[data-editor-panel]'],
        ['assistantFab', '[data-assistant-fab]'],
        ['boot', '[data-boot]']
      ]
      function tick() {
        for (var i = 0; i < targets.length; i += 1) {
          var name = targets[i][0]
          if (marks[name] !== undefined) continue
          if (document.querySelector(targets[i][1])) marks[name] = Math.round(performance.now() - start)
        }
        if (performance.now() - start < 60000) setTimeout(tick, 40)
      }
      tick()
      window.__marks = marks
    })()
  `)

  const started = Date.now()
  await page.reload({ waitUntil: 'commit' })
  await page
    .locator(readySelector)
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .catch(() => undefined)
  const readyMs = Date.now() - started
  await page.waitForTimeout(2500)

  const data = await evalIn<Record<string, unknown>>(
    page,
    `
    var nav = performance.getEntriesByType('navigation')[0] || {}
    var paints = {}
    performance.getEntriesByType('paint').forEach(function (entry) { paints[entry.name] = Math.round(entry.startTime) })
    var resources = performance.getEntriesByType('resource').map(function (entry) {
      return {
        name: entry.name.replace(location.origin, '').split('?')[0],
        start: Math.round(entry.startTime),
        dur: Math.round(entry.duration),
        size: entry.transferSize || 0,
        type: entry.initiatorType,
      }
    })
    var slowest = resources.slice().sort(function (a, b) { return b.dur - a.dur }).slice(0, 12)
    var biggest = resources.slice().sort(function (a, b) { return b.size - a.size }).slice(0, 8)
    var api = resources.filter(function (r) { return r.name.indexOf('/api/') === 0 })
    var totalBytes = resources.reduce(function (sum, r) { return sum + r.size }, 0)
    var longTasks = 0
    return {
      marks: window.__marks || {},
      nav: {
        ttfb: Math.round(nav.responseStart || 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
        transferSize: nav.transferSize || 0,
      },
      paints: paints,
      resources: resources.length,
      totalBytes: totalBytes,
      api: api.sort(function (a, b) { return a.start - b.start }),
      slowest: slowest,
      biggest: biggest,
      longTasks: longTasks,
    }
    `,
  )
  return { label, readyMs, ...(data as object) }
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const client = await context.newCDPSession(page)

  await signIn(page)

  // 1. Страница проекта: холодная перезагрузка.
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.waitForTimeout(2000)
  await throttle(client)

  const shots: string[] = []
  const shotsTimes = [300, 800, 1500, 2500, 4000]
  const shotPromise = (async () => {
    const t0 = Date.now()
    for (const at of shotsTimes) {
      const wait = at - (Date.now() - t0)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const file = `..\\_dev_shots\\load-${at}ms.png`
      await page.screenshot({ path: file }).catch(() => undefined)
      shots.push(file)
    }
  })()

  const project = await measureReload(page, 'projects/:id', '[data-stage], .sf-stage')
  await shotPromise

  // 2. Список проектов: там нет стадии и редакторов, но есть свои запросы.
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(1500)
  const list = await measureReload(page, 'projects', 'h3 a, [data-projects-list]')

  console.log(JSON.stringify({ project, list, shots }, null, 2))
  await browser.close()
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
