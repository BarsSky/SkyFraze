/**
 * Живая проверка ОКНА ПОМОЩНИКА как его видит человек (0.145.x).
 *
 * Зачем скрипт. Прямые запросы к /stream через curl работают, а из браузера человек получает
 * «Помощник не ответил. Проверьте связь и модель.» Сервер при этом видит `context canceled` —
 * то есть соединение закрывается со стороны клиента. Здесь мы повторяем путь человека: реальный
 * браузер, реальная страница, реальное окно помощника, и пишем всё, что видно из браузера:
 * сетевые обрывы, ошибки консоли, текст ошибки на экране и живой текст ответа.
 *
 * Запуск (стенд, без логина — токен подставляется в localStorage):
 *   cd frontend
 *   $env:VISUAL_BASE_URL='https://fraze.skynas.ru'
 *   $env:TOKEN=(Get-Content -Raw ..\_dev\jwt.txt)
 *   $env:PROJECT_ID='7fec44b0-0b2b-4959-b13b-0caa43659390'
 *   npx tsx ../_dev/chat-check.ts
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.VISUAL_BASE_URL ?? 'https://fraze.skynas.ru'
const TOKEN = process.env.TOKEN ?? ''
const REFRESH = process.env.REFRESH ?? ''
const PROJECT_ID = process.env.PROJECT_ID ?? '7fec44b0-0b2b-4959-b13b-0caa43659390'
const QUESTION = process.env.QUESTION ?? 'помоги с орфографией и стилем'
const LIMIT_MS = Number(process.env.LIMIT_MS ?? 8 * 60_000)
const SHOT = process.env.SHOT ?? '..\\_dev_shots\\assistant-live.png'

async function main() {
  if (!TOKEN) {
    console.error('нужен TOKEN (access-токен стенда)')
    process.exit(1)
  }
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
  const page = await context.newPage()

  const log: string[] = []
  // До загрузки приложения: сессия в том же хранилище, что использует интерфейс.
  // refreshToken обязателен: RequireAuth пускает только с ним (иначе уводит на /login).
  await context.addInitScript(
    `(() => {
       const raw = localStorage.getItem('skyfraze-auth');
       if (raw) return; // уже есть — не трогаем
       localStorage.setItem('skyfraze-auth', JSON.stringify({
         state: { accessToken: ${JSON.stringify(TOKEN)}, refreshToken: ${JSON.stringify(REFRESH)}, user: null, ready: false },
         version: 0,
       }));
     })()`,
  )

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') log.push(`console.${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', (err) => log.push(`pageerror: ${err.message}`))
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/')) log.push(`requestfailed: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`)
  })
  page.on('response', (res) => {
    if (res.url().includes('/ai/conversations')) {
      log.push(`response: ${res.status()} через ${at()} (${res.headers()['content-type'] ?? '—'})`)
      void res
        .finished()
        .then(() => log.push(`${at()} ответ сервера ЗАВЕРШЁН (поток закрыт сервером)`))
        .catch((err) => log.push(`${at()} ответ сервера оборван: ${err}`))
    }
  })

  const started = Date.now()
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)} с`

  // Первый заход нужен только чтобы приложение обменяло наш токен на пользователя
  // (`/api/auth/me`): до этого стража уводит на /login и обратно не возвращает.
  await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  if (page.url().includes('/login')) {
    log.push(`${at()} первый заход увёл на /login — заходим снова, токен уже обменян`)
    await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
  }

  // Окно помощника: кнопка в доке. Если оно уже открыто — просто работаем.
  const assistantButton = page.getByRole('button', { name: 'Помощник' })
  if (await assistantButton.count()) {
    const visible = await page.getByRole('button', { name: 'Спросить' }).isVisible().catch(() => false)
    if (!visible) {
      await assistantButton.first().click().catch(() => {})
      await page.waitForTimeout(1500)
    }
  }

  const input = page.getByLabel('Сообщение помощнику')
  await input.waitFor({ state: 'visible', timeout: 30_000 })
  await input.fill(QUESTION)
  log.push(`${at()} нажимаю «Спросить» (${QUESTION})`)
  await page.getByRole('button', { name: 'Спросить' }).click()

  let outcome = 'ничего не произошло'
  const deadline = Date.now() + LIMIT_MS
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    // Только встроенные выражения: esbuild добавляет `__name` для объявленных внутри
    // функций, и в браузере такая вставка падает с ReferenceError.
    const state = await page.evaluate(() => ({
      error: (document.querySelector('[data-assistant-error], .ai-error')?.textContent ?? '').trim(),
      live: (document.querySelector('[data-assistant-live]')?.textContent ?? '').trim(),
      draft: (document.querySelector('[data-assistant-draft]')?.textContent ?? '').trim(),
      thinking: (document.querySelector('[data-assistant-thinking]')?.textContent ?? '').trim(),
      stopped: (document.querySelector('[data-assistant-stopped]')?.textContent ?? '').trim(),
    }))
    if (state.error) {
      outcome = `ОШИБКА на экране: ${state.error}`
      break
    }
    if (state.stopped) {
      outcome = `остановлено: ${state.stopped}`
      break
    }
    if (state.live || state.draft) {
      log.push(`${at()} идёт текст: live=${state.live.length} draft=${state.draft.length} thinking=${state.thinking}`)
      // ждём ещё: нам важно, доедет ли ответ до конца
      if (state.live.length > 200) {
        outcome = `ответ идёт: live=${state.live.length} draft=${state.draft.length}`
      }
    }
  }

  await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {})
  log.push(`${at()} итог: ${outcome}`)
  console.log(log.join('\n'))
  console.log(`\nскриншот: ${SHOT}`)
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
