// Проверка развёрнутого стенда: страницы открываются, форма первого администратора
// показывается, лента доступна без входа, защищённые страницы закрыты. Ничего не создаёт.
//
// Запуск:  DEPLOY_URL=http://192.168.13.66 npx tsx tests/deployed-smoke.ts
// По умолчанию — локальный стенд http://localhost.

import { chromium } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.DEPLOY_URL ?? 'http://localhost'
const OUT = process.env.DEPLOY_SHOTS ?? 'C:/Projects/_deploy_check'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const problems: string[] = []
const notes: string[] = []
const ok = (label: string, cond: boolean, detail = '') =>
  cond ? notes.push(label) : problems.push(`${label}${detail ? ' — ' + detail : ''}`)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(e.message))

// 1. Регистрация: пустая инсталляция → форма первого администратора
await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' })
const regTitle = (await page.locator('h1').innerText()).trim()
ok('форма первого администратора', /Первый администратор/i.test(regTitle), regTitle)
const regHint = await page.locator('p.muted').first().innerText()
ok('объяснено, что первый аккаунт — админ', /администратор/i.test(regHint), regHint.slice(0, 80))
const hasMessageField = (await page.locator('textarea').count()) > 0
ok('в режиме bootstrap нет поля «заявка»', !hasMessageField)
await page.screenshot({ path: `${OUT}/register-bootstrap.png` })

// 2. Лента без входа
await page.goto(`${BASE}/feed`, { waitUntil: 'networkidle' })
const feedText = await page.locator('body').innerText()
ok('лента открывается без входа', /Публичные истории/i.test(feedText), feedText.slice(0, 60))
ok('лента пустая и объясняет почему', /Пока ничего не опубликовано/i.test(feedText))
await page.screenshot({ path: `${OUT}/feed-empty.png` })

// 3. Вход
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
ok('страница входа есть', (await page.locator('input[type=email]').count()) === 1)
ok('есть ссылка на регистрацию', /Регистрация/i.test(await page.locator('body').innerText()))
await page.screenshot({ path: `${OUT}/login.png` })

// 4. Тема переключается (переключатель живёт в шапке, а она есть на публичных страницах)
await page.goto(`${BASE}/feed`, { waitUntil: 'networkidle' })
await page.click('button[aria-label="Переключить тему"]')
await page.waitForTimeout(700)
const theme = await page.evaluate(`document.documentElement.dataset.theme`)
ok('светлая тема включается', theme === 'light', String(theme))
await page.screenshot({ path: `${OUT}/feed-light.png` })

// 5. Редиректы: корень ведёт анонима в ленту
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
ok('корень ведёт анонима в ленту', page.url().includes('/feed'), page.url())

// 6. Защищённая страница недоступна анониму
await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' })
ok('аноним не попадает в проекты', page.url().includes('/login'), page.url())

ok('нет ошибок в консоли', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await browser.close()
console.log(`\n=== ПРОВЕРКА СТЕНДА ${BASE} ===`)
for (const n of notes) console.log(`  ok   ${n}`)
for (const p of problems) console.log(`  FAIL ${p}`)
console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
process.exit(problems.length ? 1 : 0)
