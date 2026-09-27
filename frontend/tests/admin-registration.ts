// Администрирование развёртывания: режим регистрации и заявки на доступ.
//
// Сценарий проверяется целиком через интерфейс:
//   по умолчанию режим «по заявке» → новый человек оставляет заявку →
//   войти до решения нельзя (с понятным текстом) → администратор одобряет в /admin →
//   человек входит своим паролем и прав администратора не получает →
//   отклонённая заявка объясняет отказ → переключение на «Свободную» открывает
//   регистрацию → возврат в «По заявке».
//
// Запуск: npx tsx tests/admin-registration.ts   (нужен поднятый docker compose)

import { chromium, request, type APIRequestContext, type Page } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = 'C:/Projects/SkyFraze/_admin_shots'
const ADMIN = { email: process.env.AUDIT_EMAIL ?? 'galactic.test@e.com', password: process.env.AUDIT_PASS ?? 'hunter22!' }

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
  return ((await res.json()) as { tokens: { access: string } }).tokens.access
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button[type=submit]')
}

/** Оставленная заявка нужна, чтобы проверить оба решения администратора. */
async function submitRequest(api: APIRequestContext, email: string, name: string, message = '') {
  return await api.post(`${BASE}/api/auth/registration-requests`, {
    data: { email, password: 'hunter22!', display_name: name, message },
  })
}

async function main() {
  const browser = await chromium.launch()
  const api = await request.newContext()
  const adminToken = await apiLogin(api, ADMIN.email, ADMIN.password)
  const adminAuth = { Authorization: `Bearer ${adminToken}` }

  // Исходное состояние — «по заявке», как по умолчанию при развёртывании.
  await api.patch(`${BASE}/api/admin/settings`, {
    headers: adminAuth,
    data: { registration_mode: 'request' },
  })
  const config = (await (await api.get(`${BASE}/api/auth/config`)).json()) as { registration_mode: string }
  ok('по умолчанию режим «по заявке»', config.registration_mode === 'request', config.registration_mode)

  const direct = await api.post(`${BASE}/api/auth/register`, {
    data: { email: `blocked-${Date.now()}@e.com`, password: 'hunter22!', display_name: 'Blocked' },
  })
  ok('прямая регистрация закрыта', direct.status() === 403, `статус ${direct.status()}`)

  const stamp = Date.now()
  const approvedEmail = `approved-${stamp}@e.com`
  const rejectedEmail = `rejected-${stamp}@e.com`

  // ── заявка через интерфейс
  const applicant = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const applicantPage = await applicant.newPage()
  await applicantPage.goto(`${BASE}/register`, { waitUntil: 'networkidle' })
  const registerTitle = await applicantPage.locator('h1').innerText()
  ok('страница регистрации объясняет режим', /Заявка на доступ/i.test(registerTitle), registerTitle)
  await applicantPage.fill('input[placeholder="имя"]', 'Approved Person')
  await applicantPage.fill('input[type=email]', approvedEmail)
  await applicantPage.fill('input[type=password]', 'hunter22!')
  await applicantPage.fill('textarea', 'Хочу собрать таймлайн по своей книге')
  await applicantPage.screenshot({ path: `${OUT}/register-request.png` })
  await applicantPage.click('button[type=submit]')
  await applicantPage.waitForTimeout(1200)
  const afterSubmit = await applicantPage.locator('body').innerText()
  ok('заявка принята интерфейсом', /Заявка отправлена/i.test(afterSubmit), afterSubmit.slice(0, 60))

  // ── вход до решения администратора
  await uiLogin(applicantPage, approvedEmail, 'hunter22!')
  await applicantPage.waitForTimeout(1200)
  const pendingText = await applicantPage.locator('.error').innerText().catch(() => '')
  ok('вход до одобрения запрещён с объяснением', /не одобрена/i.test(pendingText), pendingText)

  // ── отклонённая заявка
  const rejectedRes = await submitRequest(api, rejectedEmail, 'Rejected Person', 'спам')
  ok('вторая заявка создана', rejectedRes.status() === 202, `статус ${rejectedRes.status()}`)
  const pendingList = (await (
    await api.get(`${BASE}/api/admin/registrations?status=pending`, { headers: adminAuth })
  ).json()) as { requests: Array<{ id: string; email: string }> }
  const rejectedReq = pendingList.requests.find((r) => r.email === rejectedEmail)
  ok('заявка видна администратору', !!rejectedReq, JSON.stringify(pendingList.requests.map((r) => r.email)))
  if (rejectedReq) {
    const rej = await api.post(`${BASE}/api/admin/registrations/${rejectedReq.id}/reject`, {
      headers: adminAuth,
      data: { note: 'не подходит' },
    })
    ok('отклонение заявки', rej.ok(), `статус ${rej.status()}`)
  }
  const rejectedLogin = await api.post(`${BASE}/api/auth/login`, {
    data: { email: rejectedEmail, password: 'hunter22!' },
  })
  ok('вход по отклонённой заявке запрещён', rejectedLogin.status() === 403, `статус ${rejectedLogin.status()}`)

  // ── администратор одобряет заявку в интерфейсе
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const adminPage = await adminCtx.newPage()
  await uiLogin(adminPage, ADMIN.email, ADMIN.password)
  await adminPage.waitForURL(/projects/, { timeout: 15000 })
  const headerLinks = await adminPage.locator('.auth-links a').allInnerTexts()
  ok('у администратора есть ссылка в админку', headerLinks.some((t) => /Админка/i.test(t)), headerLinks.join(','))
  await adminPage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
  await adminPage.waitForSelector('.admin__request', { timeout: 15000 })
  const adminBody = await adminPage.locator('body').innerText()
  ok('админка показывает заявку', adminBody.includes(approvedEmail), adminBody.slice(0, 80))
  ok('админка показывает режим регистрации', /По заявке/i.test(adminBody), adminBody.slice(0, 80))
  await adminPage.screenshot({ path: `${OUT}/admin-pending.png` })

  await adminPage
    .locator('.admin__request', { hasText: approvedEmail })
    .locator('button:has-text("Одобрить")')
    .click()
  await adminPage.waitForTimeout(1500)
  const afterApprove = await adminPage.locator('body').innerText()
  ok('одобрение подтверждено в интерфейсе', new RegExp(`Доступ для ${approvedEmail}`).test(afterApprove), afterApprove.slice(0, 100))

  // ── одобренный человек входит своим паролем и не получает прав админа
  const approvedCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const approvedPage = await approvedCtx.newPage()
  await uiLogin(approvedPage, approvedEmail, 'hunter22!')
  await approvedPage.waitForURL(/projects/, { timeout: 20000 })
  ok('одобренный пользователь вошёл', approvedPage.url().includes('/projects'), approvedPage.url())
  const approvedLinks = await approvedPage.locator('.auth-links a').allInnerTexts()
  ok('у обычного пользователя нет ссылки в админку', !approvedLinks.some((t) => /Админка/i.test(t)), approvedLinks.join(','))
  await approvedPage.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
  const denied = await approvedPage.locator('body').innerText()
  ok('обычному пользователю админка закрыта', /Нужны права администратора/i.test(denied), denied.slice(0, 60))
  const deniedApi = await approvedPage.evaluate(`(async () => {
    const raw = window.localStorage.getItem('skyfraze-auth')
    const token = raw ? (JSON.parse(raw).state || {}).accessToken : null
    const res = await fetch('/api/admin/settings', { headers: { Authorization: 'Bearer ' + (token || '') } })
    return res.status
  })()`)
  ok('API админки отдаёт 403 обычному пользователю', deniedApi === 403, `статус ${deniedApi}`)

  // ── переключение режима открывает свободную регистрацию
  await adminPage.bringToFront()
  await adminPage.click('button.admin__mode:has-text("Свободная")')
  await adminPage.waitForTimeout(1200)
  const modeAfter = (await (await api.get(`${BASE}/api/auth/config`)).json()) as { registration_mode: string }
  ok('режим переключён на свободный', modeAfter.registration_mode === 'open', modeAfter.registration_mode)

  const openCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const openPage = await openCtx.newPage()
  await openPage.goto(`${BASE}/register`, { waitUntil: 'networkidle' })
  const openTitle = await openPage.locator('h1').innerText()
  ok('в свободном режиме форма обычной регистрации', /^Регистрация$/i.test(openTitle.trim()), openTitle)
  const freeEmail = `free-${stamp}@e.com`
  await openPage.fill('input[placeholder="имя"]', 'Free Person')
  await openPage.fill('input[type=email]', freeEmail)
  await openPage.fill('input[type=password]', 'hunter22!')
  await openPage.click('button[type=submit]')
  await openPage.waitForURL(/projects/, { timeout: 20000 })
  ok('свободная регистрация работает', openPage.url().includes('/projects'), openPage.url())
  await openPage.screenshot({ path: `${OUT}/free-register.png` })

  // ── возвращаем режим «по заявке»: это состояние по умолчанию
  await adminPage.bringToFront()
  await adminPage.click('button.admin__mode:has-text("По заявке")')
  await adminPage.waitForTimeout(1200)
  const finalMode = (await (await api.get(`${BASE}/api/auth/config`)).json()) as { registration_mode: string }
  ok('режим возвращён в «по заявке»', finalMode.registration_mode === 'request', finalMode.registration_mode)
  await adminPage.screenshot({ path: `${OUT}/admin-after.png` })

  await api.dispose()
  await browser.close()

  console.log('\n=== АДМИНИСТРИРОВАНИЕ РЕГИСТРАЦИИ ===')
  for (const n of notes) console.log(`  ok   ${n}`)
  for (const p of problems) console.log(`  FAIL ${p}`)
  console.log(`\nошибок: ${problems.length}, проверок: ${notes.length}`)
  process.exit(problems.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
