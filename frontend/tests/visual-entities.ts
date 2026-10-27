/**
 * Живой инструмент: снимок блока «Связи проекта» (в CI не гоняется).
 * Запуск: npx tsx tests/visual-entities.ts (backend :8181 и vite :5173 подняты)
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = 'visual.entities@example.com'
const PASSWORD = 'hunter22!'

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await context.newPage()

  await registerIfPossible(page)
  await page.goto(`${BASE}/projects`)
  await openProject(page)

  const block = page.locator('[data-entities]')
  await block.waitFor({ state: 'visible', timeout: 30_000 })
  const summary = block.locator('summary')
  await summary.click() // раскрыть: по умолчанию блок закрыт, чтобы не отнимать место у дерева

  await page.getByLabel('Имя карточки', { exact: true }).fill('Анна')
  await page.getByLabel('Алиасы карточки', { exact: true }).fill('Аня, Анны')
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.locator('[data-entities-list]').waitFor({ state: 'visible', timeout: 15_000 })

  // Место и тема — чтобы было видно группировку по видам.
  await page.getByLabel('Вид карточки').selectOption('place')
  await page.getByLabel('Имя карточки', { exact: true }).fill('Дом на холме')
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByLabel('Вид карточки').selectOption('theme')
  await page.getByLabel('Имя карточки', { exact: true }).fill('Письмо')
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.waitForTimeout(400)

  await block.screenshot({ path: 'visual-entities.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await block.screenshot({ path: 'visual-entities-mobile.png' })

  await browser.close()
  console.log('снимки готовы')
}

async function registerIfPossible(page: Page) {
  await page.goto(`${BASE}/register`)
  const heading = await page.locator('h1').innerText()
  if (!/Первый администратор|Регистрация/.test(heading)) return
  await page.getByPlaceholder('имя').fill('Мир Проекта')
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
  await page.getByRole('button', { name: 'Создать' }).click()
  // Повторный прогон на той же базе: адрес уже занят, это не ошибка инструмента.
  await Promise.race([
    page.waitForURL(/\/projects$/, { timeout: 12_000 }),
    page.waitForTimeout(12_000),
  ]).catch(() => {})
  // Войти, если регистрация не состоялась (адрес уже был).
  if (!/\/projects$/.test(new URL(page.url()).pathname)) {
    await page.goto(`${BASE}/login`)
    await page.getByPlaceholder('email').fill(EMAIL)
    await page.getByPlaceholder('пароль').fill(PASSWORD)
    await page.getByRole('button', { name: /Войти/ }).click()
    await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  }
}

/** Открыть первый проект (или создать, если список пуст). */
async function openProject(page: Page) {
  const link = page.locator('a[href*="/projects/"]').first()
  if ((await link.count()) === 0) {
    // Пустой список: заводим проект через форму «+ Новый проект».
    await page.getByRole('button', { name: '+ Новый проект' }).click()
    await page.getByPlaceholder('Название').fill('Мир проекта')
    await page.getByRole('button', { name: 'Создать' }).click()
    await page.waitForTimeout(1500)
  }
  const projectLink = page.locator('a[href*="/projects/"]').first()
  await projectLink.waitFor({ state: 'visible', timeout: 20_000 })
  await projectLink.click()
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 20_000 })

  // Панель «Редакторы» рисуется только в проекте, где уже есть кадры (в пустом её нет —
  // так задумано). Ждём ПОЯВЛЕНИЯ либо панели, либо кнопки пустого проекта: `count()`
  // сразу после перехода успевает увидеть ещё не отрисованную страницу.
  const panel = page.locator('[data-editor-panel]')
  const firstChapter = page.getByRole('button', { name: /Добавить первую главу/ })
  for (let i = 0; i < 20; i += 1) {
    if (await panel.isVisible().catch(() => false)) return
    if (await firstChapter.isVisible().catch(() => false)) {
      await firstChapter.click()
      await page.waitForTimeout(1500)
      continue
    }
    await page.waitForTimeout(750)
  }
  throw new Error('панель редакторов не появилась: в проекте нет кадров')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
