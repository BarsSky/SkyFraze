/**
 * Живая проверка точек входа в фичу DOCX (0.94.1).
 *
 * Отчёт: «не нашел в интерфейсе то, что ты описал… кнопки Настройки проекта тоже нигде не видно…
 * в самом редакторе нету панели Разметка DOCX». Фича была на месте, но за тремя кликами, о
 * которых нигде не сказано. Проверяем пути человека:
 *   1. «Настройки» стоят в ряду вкладок проекта (Проект, Редакторы, Связи, Версии, Настройки) и
 *      ведут на страницу настроек, где лежит блок «Оформление DOCX» со справкой и примером;
 *   2. в редакторе кадра есть кнопка «Разметка DOCX», и она открывает окно с УЖЕ РАСКРЫТОЙ
 *      панелью маркеров — искать вторую кнопку внутри не нужно.
 *
 * Запуск: cd frontend && npx tsx tests/diag-docx-entry.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })

  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  const tabs = page.locator('[data-project-tabs]')
  await tabs.waitFor({ state: 'visible', timeout: 30_000 })
  const names = await tabs.getByRole('tab').allInnerTexts()
  console.log(`вкладки: ${names.map((name) => name.trim()).join(', ')}`)
  if (!names.some((name) => name.includes('Настройки'))) problems.push('в ряду вкладок нет «Настроек»')

  // 1. «Настройки» ведут на страницу настроек, и там есть блок оформления DOCX со справкой.
  const settingsTab = page.locator('[data-project-tab="settings"]')
  await settingsTab.click()
  await page.waitForURL(/\/settings$/, { timeout: 20_000 })
  const docxBlock = page.locator('[data-docx-templates]')
  await docxBlock.waitFor({ state: 'visible', timeout: 20_000 })
  await docxBlock.getByRole('button', { name: 'Как сделать шаблон' }).waitFor({ state: 'visible', timeout: 10_000 })
  await docxBlock.getByRole('button', { name: 'Скачать пример .docx' }).waitFor({ state: 'visible', timeout: 10_000 })
  console.log('настройки: блок «Оформление DOCX» со справкой и примером на месте')
  // Снимок — с блоком в кадре: он ниже блоков участников, и без прокрутки его не видно.
  await docxBlock.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '..\\_dev_shots\\docx-entry-settings.png' })

  // 2. Кнопка «Разметка DOCX» в редакторе кадра открывает окно с раскрытой панелью маркеров.
  // Возвращаемся на страницу проекта: настройки — отдельная страница со своими вкладками.
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-project-tab="editors"]').click()
  const row = page.locator('.ed-row').first()
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  await row.click()
  const button = page.getByRole('button', { name: 'Разметка DOCX' })
  await button.waitFor({ state: 'visible', timeout: 20_000 })
  await button.click()
  const editor = page.locator('.md-editor')
  await editor.waitFor({ state: 'visible', timeout: 20_000 })
  // Панель раскрыта: кнопки маркеров видны сразу, без второго нажатия.
  await editor.getByRole('button', { name: 'разрыв страницы' }).waitFor({ state: 'visible', timeout: 10_000 })
  await editor.getByRole('button', { name: 'оглавление' }).waitFor({ state: 'visible', timeout: 10_000 })
  const expanded = await editor.getByRole('button', { name: /Разметка DOCX/ }).getAttribute('aria-expanded')
  console.log(`панель «Разметка DOCX» в редакторе: раскрыта=${expanded}`)
  if (expanded !== 'true') problems.push('панель открылась свёрнутой')
  await page.screenshot({ path: '..\\_dev_shots\\docx-entry-editor.png' })

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимки: docx-entry-settings.png, docx-entry-editor.png')
}

await main()
