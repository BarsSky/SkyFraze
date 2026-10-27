/**
 * Живой инструмент: эго-граф связей (0.75.0, в CI не гоняется).
 *
 * Сам создаёт данные, если их нет: карточки и связи. Иначе проверять нечего.
 * Запуск: npx tsx tests/visual-graph.ts (backend :8181 и vite :5173 подняты)
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
// Учётка должна существовать на стенде: регистрация на боевом закрыта, а «заводить» пользователя
// ради снимков неправильно. Переопределяется через VISUAL_EMAIL.
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await signIn(page)
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(1200)
  await page.locator('a[href*="/projects/"]').first().click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await openRelations(page)

  await seed(page)
  await page.reload()
  await openRelations(page)
  await page.waitForTimeout(1200)

  const graph = page.locator('[data-entity-graph]')
  if ((await graph.count()) === 0) {
    console.log('графа нет: карточек в проекте нет')
    await browser.close()
    return
  }
  await graph.screenshot({ path: 'visual-graph.png' })
  const mode = await graph.getAttribute('data-entity-graph')
  const center = await page
    .locator('[data-entity-graph-center]')
    .innerText()
    .catch(() => '—')
  const nodes = await page.locator('[data-entity-graph-node]').count()
  console.log(`режим: ${mode}, центр: ${center}, соседей: ${nodes}`)

  if (nodes > 0) {
    const first = page.locator('[data-entity-graph-node]').first()
    const name = await first.innerText()
    await first.click()
    await page.waitForTimeout(500)
    const newCenter = await page
      .locator('[data-entity-graph-center]')
      .innerText()
      .catch(() => '—')
    console.log(`клик по «${name}» → центр «${newCenter}»`)
    await graph.screenshot({ path: 'visual-graph-after.png' })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  await page.locator('[data-entity-graph]').screenshot({ path: 'visual-graph-mobile.png' })
  await browser.close()
}

/**
 * Открыть «Связи»: с 0.83.0 это вкладка у владельца, а у читателя — раздел ниже по странице.
 * Ждём именно видимости: полоса вкладок появляется асинхронно, вместе с догрузкой проекта.
 */
async function openRelations(page: Page) {
  const tab = page.locator('[data-project-tab="relations"]')
  await tab.waitFor({ state: 'visible', timeout: 45_000 }).catch(() => undefined)
  if ((await tab.count()) > 0) await tab.click()
  await page.locator('[data-relations]').waitFor({ state: 'visible', timeout: 45_000 })
}

/**
 * Карточки и связи через API, если в проекте их ещё нет.
 *
 * Код браузера — СТРОКОЙ, а не функцией: tsx/esbuild оборачивает функции в `__name`, которого в
 * браузере нет, и `page.evaluate` падает с «__name is not defined» (та же ловушка, что в
 * diag-load.ts и diag-gap.ts).
 */
async function seed(page: Page) {
  const projectId = new URL(page.url()).pathname.split('/').pop()
  await page.evaluate(`(async (pid) => {
    var token = JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
    var base = '/api/projects/' + pid + '/entities'
    function addLink(from, to, label) {
      return fetch(base + '/' + from + '/links', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ to: to, label: label }),
      })
    }
    function create(kind, name) {
      return fetch(base, { method: 'POST', headers: headers, body: JSON.stringify({ kind: kind, name: name }) })
        .then(function (r) { return r.json() })
        .then(function (data) { return data.entity })
    }
    var cards = (await fetch(base, { headers: headers }).then(function (r) { return r.json() })).entities || []
    if (cards.length >= 3) {
      var links = (await fetch(base + '/links', { headers: headers }).then(function (r) { return r.json() })).links || []
      if (links.length === 0) {
        await addLink(cards[0].id, cards[1].id, 'связана с')
        await addLink(cards[0].id, cards[2].id, 'видит')
      }
      return
    }
    var anya = await create('character', 'Аня')
    var earth = await create('place', 'Земля')
    var letter = await create('theme', 'Письмо')
    var guard = await create('character', 'Сторож')
    await addLink(anya.id, earth.id, 'живёт на')
    await addLink(anya.id, letter.id, 'получает')
    await addLink(anya.id, guard.id, 'боится')
  })(${JSON.stringify(projectId)})`)
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
