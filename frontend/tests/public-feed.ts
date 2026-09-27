// Публичная лента: чтение без входа, оценки только вошедшим, никаких правок.
//
// Проверяется сквозной сценарий на живом стенде:
//   владелец публикует проект → аноним видит историю в ленте и открывает её →
//   кнопок редактирования на публичной странице нет → аноним не может оценить →
//   второй пользователь ставит и меняет оценку → владелец оценить не может →
//   снятие с публикации убирает историю из ленты и закрывает ссылку.
//
// Запуск: npx tsx tests/public-feed.ts   (нужен поднятый docker compose)

import { chromium, request, type APIRequestContext, type Page } from 'playwright'
import * as fs from 'fs'
import { ensureTestUser } from './helpers/testUser'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = 'C:/Projects/SkyFraze/_feed_shots'
const OWNER = { email: 'galactic.test@e.com', password: 'hunter22!' }
const DEMO_ID = process.env.AUDIT_PROJECT ?? 'b8938a83-3b39-42ba-9edd-e0d6c206c548'

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const problems: string[] = []
const notes: string[] = []

function ok(label: string, condition: boolean, detail = '') {
  if (condition) notes.push(label)
  else problems.push(`${label}${detail ? ' — ' + detail : ''}`)
}

async function apiLogin(api: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await api.post(`${BASE}/api/auth/login`, { data: { email, password } })
  if (!res.ok()) throw new Error(`login ${email}: ${res.status()}`)
  const body = (await res.json()) as { tokens: { access: string } }
  return body.tokens.access
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForURL(/projects/, { timeout: 15000 })
}

async function main() {
  const browser = await chromium.launch()
  const api = await request.newContext()

  // ── владелец публикует демо-проект
  const ownerToken = await apiLogin(api, OWNER.email, OWNER.password)
  const ownerAuth = { Authorization: `Bearer ${ownerToken}` }

  const pubRes = await api.post(`${BASE}/api/projects/${DEMO_ID}/publication`, {
    headers: ownerAuth,
    data: { is_public: true },
  })
  ok('публикация владельцем', pubRes.ok(), `статус ${pubRes.status()}`)
  const published = (await pubRes.json()) as { public_slug?: string; is_public: boolean }
  const slug = published.public_slug ?? ''
  ok('выдан публичный slug', !!slug, JSON.stringify(published))

  // ── лента анонимно
  const anonCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const anon = await anonCtx.newPage()
  const consoleErrors: string[] = []
  anon.on('pageerror', (e) => consoleErrors.push(e.message))

  await anon.goto(`${BASE}/feed`, { waitUntil: 'networkidle' })
  ok('лента открывается без входа', anon.url().endsWith('/feed'), anon.url())
  const cards = anon.locator('.feed-card')
  await cards.first().waitFor({ timeout: 15000 }).catch(() => null)
  const cardCount = await cards.count()
  ok('в ленте есть опубликованная история', cardCount >= 1, `карточек ${cardCount}`)
  const cardText = cardCount > 0 ? await cards.first().innerText() : ''
  ok('карточка показывает автора', cardText.includes('Galactic Test'), cardText.slice(0, 80))
  ok('карточка показывает просмотры', /просмотр/.test(cardText), cardText.slice(0, 120))
  ok('карточка показывает оценки', /оцен|★/.test(cardText), cardText.slice(0, 120))
  await anon.screenshot({ path: `${OUT}/anon-feed.png` })

  // ── публичная история: таймлайн виден, правок нет
  await cards.first().locator('a').first().click()
  await anon.waitForURL(/\/s\//, { timeout: 15000 })
  await anon.waitForSelector('.sf-track', { timeout: 20000 })
  const stage = await anon.locator('.sf-track').boundingBox()
  ok('публичная история рисует стадию', !!stage && stage.height > 100, JSON.stringify(stage))
  const publicTitle = await anon.locator('.sf-copy__title').first().innerText()
  ok('виден заголовок кадра', publicTitle.length > 0, publicTitle)

  // Публичная страница не должна содержать ничего для изменения истории.
  const editControls = await anon.evaluate(`(() => {
    const sel = ['[data-editor-panel]', '.ed-panel', '.ed-row', '.ed-upload', 'button.ed-btn']
    const found = []
    for (const s of sel) if (document.querySelector(s)) found.push(s)
    const texts = Array.from(document.querySelectorAll('button, a'))
      .map((el) => (el.textContent || '').trim().toLowerCase())
      .filter((t) => t.includes('редактор') || t.includes('опубликовать') || t.includes('удалить') || t.includes('участник'))
    return { found, texts }
  })()`) as { found: string[]; texts: string[] }
  ok('на публичной странице нет редакторов', editControls.found.length === 0, editControls.found.join(','))
  ok('на публичной странице нет кнопок правки', editControls.texts.length === 0, editControls.texts.join(','))

  const stars = anon.locator('.pub-rating__star')
  ok('оценки видны анониму', (await stars.count()) === 5, `звёзд ${await stars.count()}`)
  const anonNote = await anon.locator('.pub-rating__note').first().innerText().catch(() => '')
  ok('анониму объяснено, что нужен вход', /войд/i.test(anonNote), anonNote)
  await anon.screenshot({ path: `${OUT}/anon-story.png` })

  // Клик по звезде анонимом ведёт на вход, а не молча ничего не делает.
  await stars.nth(3).click()
  await anon.waitForURL(/login/, { timeout: 10000 }).catch(() => null)
  ok('анонимный клик по звезде ведёт на вход', anon.url().includes('/login'), anon.url())

  // ── повторный просмотр не накручивает счётчик (считаем по интерфейсу:
  //    серверный fetch без cookie каждый раз выглядит новым посетителем)
  const viewsPage = await anonCtx.newPage()
  await viewsPage.goto(`${BASE}/s/${slug}`, { waitUntil: 'networkidle' })
  await viewsPage.waitForSelector('.pub-meta__views', { timeout: 20000 })
  const viewsFirst = (await viewsPage.locator('.pub-meta__views').innerText()).trim()
  await viewsPage.reload({ waitUntil: 'networkidle' })
  await viewsPage.waitForSelector('.pub-meta__views', { timeout: 20000 })
  const viewsSecond = (await viewsPage.locator('.pub-meta__views').innerText()).trim()
  ok('повторный просмотр не накручивает счётчик', viewsFirst === viewsSecond, `«${viewsFirst}» → «${viewsSecond}»`)
  await viewsPage.close()

  // ── сеть отвалилась: должна быть понятная плашка с выходами, а не сырой текст
  const failCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const failPage = await failCtx.newPage()
  await failPage.route('**/api/public/stories/**', (route) => route.abort('failed'))
  await failPage.goto(`${BASE}/s/${slug}`, { waitUntil: 'domcontentloaded' })
  const bannerShown = await failPage
    .waitForSelector('.banner', { timeout: 25000 })
    .then(() => true)
    .catch(() => false)
  ok('ошибка загрузки показана плашкой', bannerShown)
  if (bannerShown) {
    const bannerText = (await failPage.locator('.banner').innerText()).replace(/\s+/g, ' ')
    ok(
      'плашка объясняет причину по-человечески',
      /связ|не ответил|не удалось/i.test(bannerText) && !/TimeoutError|GET http/i.test(bannerText),
      bannerText,
    )
    const links = await failPage.locator('.banner a').allInnerTexts()
    ok('в плашке есть переход на доступную страницу', links.some((t) => /лент/i.test(t)), links.join(','))
    await failPage.screenshot({ path: `${OUT}/story-error-banner.png` })

    // «Повторить» после восстановления связи возвращает историю
    await failPage.unroute('**/api/public/stories/**')
    await failPage.click('.banner button:has-text("Повторить")')
    const recovered = await failPage
      .waitForSelector('.sf-track', { timeout: 25000 })
      .then(() => true)
      .catch(() => false)
    ok('кнопка «Повторить» открывает историю', recovered)
  }
  await failCtx.close()

  // ── оценка вторым пользователем.
  //    Регистрация может быть закрыта (режим «по заявке»): заводим читателя так же,
  //    как это сделал бы человек — заявкой с одобрением администратором.
  const readerEmail = `feed-reader-${Date.now()}@e.com`
  const created = await ensureTestUser(BASE, readerEmail, 'Feed Reader', OWNER)
  ok('читатель заведён', created.ok, created.note)
  const readerToken = created.access ?? ''
  if (!readerToken) {
    problems.push('не удалось получить токен читателя — дальнейшие проверки оценок пропущены')
  }

  const readerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const reader = await readerCtx.newPage()
  await reader.goto(`${BASE}/login`)
  await reader.evaluate(
    ([a, email, name]) => {
      localStorage.setItem(
        'skyfraze-auth',
        JSON.stringify({ state: { accessToken: a, refreshToken: '', user: { id: '', email, display_name: name } }, version: 0 }),
      )
    },
    [readerToken, readerEmail, 'Feed Reader'],
  )
  await reader.goto(`${BASE}/s/${slug}`, { waitUntil: 'networkidle' })
  await reader.waitForSelector('.pub-rating__star', { timeout: 20000 })
  await reader.locator('.pub-rating__star').nth(3).click() // 4 звезды
  await reader.waitForTimeout(1200)
  const readerValue = await reader.locator('.pub-rating__value').first().innerText()
  ok('оценка читателя учтена', /4[.,]0/.test(readerValue), readerValue)
  const mineCount = await reader.locator('.pub-rating__star.is-mine').count()
  ok('своя оценка отмечена в интерфейсе', mineCount === 4, `отмечено ${mineCount}`)
  await reader.screenshot({ path: `${OUT}/reader-rated.png` })

  // Повторный клик по той же звезде снимает оценку.
  await reader.locator('.pub-rating__star').nth(3).click()
  await reader.waitForTimeout(1200)
  const afterUnrate = await reader.locator('.pub-rating__value').first().innerText()
  ok('повторный клик снимает оценку', /нет оценок/.test(afterUnrate), afterUnrate)

  // ── владелец не оценивает свою историю
  const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const ownerPage = await ownerCtx.newPage()
  await uiLogin(ownerPage, OWNER.email, OWNER.password)
  await ownerPage.goto(`${BASE}/s/${slug}`, { waitUntil: 'networkidle' })
  await ownerPage.waitForSelector('.pub-rating__star', { timeout: 20000 })
  await ownerPage.locator('.pub-rating__star').nth(4).click()
  await ownerPage.waitForTimeout(1200)
  const ownerNote = await ownerPage.locator('.pub-rating__note').first().innerText().catch(() => '')
  ok('автору отказано в самооценке', /автор/i.test(ownerNote), ownerNote)

  // ── снятие с публикации закрывает историю
  const unpub = await api.post(`${BASE}/api/projects/${DEMO_ID}/publication`, {
    headers: ownerAuth,
    data: { is_public: false },
  })
  ok('снятие с публикации', unpub.ok(), `статус ${unpub.status()}`)

  const feedAfter = (await (await api.get(`${BASE}/api/public/feed`)).json()) as { items: unknown[] }
  ok('снятая история исчезла из ленты', feedAfter.items.length === 0, `осталось ${feedAfter.items.length}`)

  const closed = await api.get(`${BASE}/api/public/stories/${slug}`)
  ok('ссылка на снятую историю даёт 404', closed.status() === 404, `статус ${closed.status()}`)

  const closedPage = await anonCtx.newPage()
  await closedPage.goto(`${BASE}/s/${slug}`, { waitUntil: 'networkidle' })
  const closedText = await closedPage.locator('body').innerText()
  ok('страница снятой истории объясняет причину', /не найдена/i.test(closedText), closedText.slice(0, 80))
  await closedPage.screenshot({ path: `${OUT}/closed-story.png` })

  // Возвращаем демо-проект в публичное состояние: он — витрина проекта.
  const repub = await api.post(`${BASE}/api/projects/${DEMO_ID}/publication`, {
    headers: ownerAuth,
    data: { is_public: true },
  })
  const republished = (await repub.json()) as { public_slug?: string }
  ok('повторная публикация сохраняет ссылку', republished.public_slug === slug, `${republished.public_slug} ≠ ${slug}`)

  ok('нет ошибок в консоли страниц', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  await api.dispose()
  await browser.close()

  console.log('\n=== ПУБЛИЧНАЯ ЛЕНТА ===')
  for (const n of notes) console.log(`  ok   ${n}`)
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
  process.exit(problems.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
