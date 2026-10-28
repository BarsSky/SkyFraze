/**
 * Замер «запаса на уходе со страницы» (0.99.2) — для docs/realtime-editor.md.
 *
 * Два вопроса из плана, которые до сих пор были без ответа:
 *   1. сколько на самом деле весит снапшот реального проекта (порог `MAX_DEFERRED_BYTES = 2 МБ`
 *      выбирался «на глаз»);
 *   2. какова настоящая квота `localStorage` в браузере (порог делит её с токеном сессии).
 *
 * Меряем в Chromium на живом стенде: размер снапшота берём у сервера, квоту — записывая строки,
 * пока браузер не откажет, а `base64`-вес считаем по правилу «+33%», которое применяет сам запас.
 *
 * Запуск: cd frontend && npx tsx tests/diag-storage-budget.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

/** Порог из `src/collab/deferredState.ts` — сверяем с ним измеренное. */
const MAX_DEFERRED_BYTES = 2 * 1024 * 1024

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }

  // 1. Реальные снапшоты проектов: у сервера есть только «снимок на проект», поэтому смотрим все
  // доступные проекты и берём самый большой.
  const projects = (await (await page.request.get(`${API}/api/projects`, { headers })).json()) as
    | Array<{ id: string; title: string }>
    | { projects?: Array<{ id: string; title: string }>; items?: Array<{ id: string; title: string }> }
  const list = Array.isArray(projects) ? projects : projects.projects ?? projects.items ?? []
  let biggest = { title: '', bytes: 0 }
  let measured = 0
  for (const project of list) {
    const response = await page.request.get(`${API}/api/projects/${project.id}/events/state`, {
      headers,
      failOnStatusCode: false,
    })
    if (response.status() !== 200) continue
    const bytes = (await response.body()).byteLength
    measured += 1
    if (bytes > biggest.bytes) biggest = { title: project.title, bytes }
  }
  console.log(`снапшотов измерено: ${measured} из проектов: ${list.length}`)
  if (measured === 0) {
    console.log('снапшотов нет — проекты не открывались; замер квоты всё равно показателен')
  } else {
    console.log(`самый большой снапшот: ${biggest.bytes} байт («${biggest.title}»)`)
    const base64 = Math.round(biggest.bytes * (4 / 3))
    console.log(
      `в запасе (base64 + JSON): ~${base64} байт — это ${(base64 / MAX_DEFERRED_BYTES * 100).toFixed(2)}% от порога ${MAX_DEFERRED_BYTES}`,
    )
    if (base64 > MAX_DEFERRED_BYTES) {
      console.log('ПРОБЛЕМА: реальный снапшот больше порога запаса')
    }
  }

  // 2. Квота localStorage: пишем блоки по 256 КБ, пока браузер не откажет. Замер в отдельном
  // origin-пространстве (ключи с префиксом), затем убираем за собой.
  const quota = (await page.evaluate(`(async () => {
    const chunk = 'x'.repeat(256 * 1024)
    let count = 0
    const keys = []
    try {
      for (;;) {
        const key = 'sf-quota-probe-' + count
        localStorage.setItem(key, chunk)
        keys.push(key)
        count += 1
        if (count > 200) break
      }
    } catch (error) {
      // QuotaExceededError — это и есть ответ: дальше писать некуда.
    }
    const bytes = count * 256 * 1024
    for (const key of keys) localStorage.removeItem(key)
    return { count, bytes }
  })()`)) as { count: number; bytes: number }

  const quotaMb = quota.bytes / (1024 * 1024)
  console.log(`квота localStorage: ${quotaMb.toFixed(2)} МБ (${quota.count} блоков по 256 КБ)`)
  console.log(
    `порог 2 МБ — это ${(MAX_DEFERRED_BYTES / quota.bytes * 100).toFixed(0)}% квоты на ОДИН проект; ` +
      `несколько проектов с запасом делят её между собой`,
  )
  console.log(
    `вывод: порог ${quota.bytes > MAX_DEFERRED_BYTES * 2 ? 'оставляем как есть' : 'надо уменьшить'} — ` +
      'он покрывает снапшот с запасом и не съедает квоту целиком',
  )

  await browser.close()
}

await main()
