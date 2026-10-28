/**
 * Живая проверка кадра на телефоне в режиме «полная версия» (0.97.7).
 *
 * Отчёт: «для ПК версии на экране смартфона всё ещё не аккуратно выглядит отображение колонки
 * текста и изображения к ней». Режим полной версии даёт layout viewport ~980 CSS px: правила
 * телефона (≤860 px) не включаются, а экран физически узкий, поэтому всё, что рассчитано на
 * ноутбук, читается как обрезанное.
 *
 * Меряем то, что видно глазом: вылезает ли лист кадра за экран, обрезаны ли таблицы внутри листа
 * (у таблицы своя прокрутка — значит ли это, что её видно?), попадает ли картинка под текст.
 *
 * Запуск: cd frontend && npx tsx tests/diag-stage-phone.ts
 */
import { chromium } from 'playwright'
import type { Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

/** Кадр из отчёта: две таблицы, длинные значения, узкая колонка «Поле». */
const TITLE = 'Метаданные книги'
const BODY = `Издательская карточка

| Поле | Значение |
|---|---|
| Название | Слепой рывок |
| Автор | Андрей Ливадный |
| Серия | «Абсолютное оружие» |
| Жанры | sf space, sf action |
| Ключевые слова | серия «Абсолютное оружие», галактическая война, далёкое будущее, выживание человечества |
| Дата | 2013 |
| Издательство | Литагент «Эксмо» |
| ID издательства | 334eb225-f845-102a-9d2a-1f07c3bd69d8 |
| Файл-источник | 00 Слепой рывок.fb2. (1 238 668 байт, UTF-8 XML) |

Структура книги

| № | Раздел | Параграфов |
|---|---|---|
| 1 | Пролог | 149 |
| 2 | Глава 1 | 314 |
| 3 | Глава 2 | 420 |
| 4 | Глава 3 | 349 |
| 5 | Глава 4 | 384 |
| 6 | Глава 5 | 336 |
| 7 | Глава 6 | 337 |
| 8 | Глава 7 | 447 |
| 9 | Эпилог | 40 |
| 10 | P. S. | 41 |
| 11 | Примечание | 13 |`

type Snapshot = {
  vw: number
  vh: number
  pageScroll: number
  copy: { left: number; right: number; width: number; top: number; bottom: number } | null
  tables: Array<{ rows: number; clientWidth: number; scrollWidth: number; right: number; columns: number[] }>
  overflowing: string[]
  still: { left: number; right: number; width: number } | null
  parts: { copyH: number; scrollH: number; titleH: number; navH: number; bodyTop: number; bodyH: number }
}

async function measure(page: Page, label: string) {
  const data = await page.evaluate<Snapshot>(`(async () => {
    const round = (value) => Math.round(value)
    const copy = document.querySelector('.sf-copy')
    const copyRect = copy ? copy.getBoundingClientRect() : null
    const tables = [...document.querySelectorAll('.sf-md table')].map((table) => {
      const rect = table.getBoundingClientRect()
      const columns = [...table.querySelectorAll('thead th')].map((cell) => Math.round(cell.getBoundingClientRect().width))
      return {
        rows: table.querySelectorAll('tbody tr').length,
        clientWidth: table.clientWidth,
        scrollWidth: table.scrollWidth,
        right: round(rect.right),
        columns,
      }
    })
    const overflowing = []
    if (copyRect) {
      for (const node of copy.querySelectorAll('*')) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if (rect.right > copyRect.right + 1 || rect.left < copyRect.left - 1) {
          overflowing.push((node.tagName.toLowerCase() + '.' + (node.className || '')) .slice(0, 60) + ' @' + round(rect.left) + '..' + round(rect.right))
        }
      }
    }
    const still = document.querySelector('.sf-scene__still, .sf-scene__still--photo')
    const stillRect = still ? still.getBoundingClientRect() : null
    // Из чего сложился лист: если тексту не осталось места, видно только заголовок и кнопки.
    const height = (selector) => {
      const node = copy ? copy.querySelector(selector) : null
      return node ? round(node.getBoundingClientRect().height) : 0
    }
    const body = copy ? copy.querySelector('.sf-copy__body') : null
    const bodyRect = body ? body.getBoundingClientRect() : null
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      parts: {
        copyH: copyRect ? round(copyRect.height) : 0,
        scrollH: height('.sf-copy__scroll'),
        titleH: height('.sf-copy__title'),
        navH: height('.sf-copy__nav'),
        bodyTop: bodyRect && copyRect ? round(bodyRect.top - copyRect.top) : 0,
        bodyH: bodyRect ? round(bodyRect.height) : 0,
      },
      pageScroll: document.documentElement.scrollWidth,
      copy: copyRect ? { left: round(copyRect.left), right: round(copyRect.right), width: round(copyRect.width), top: round(copyRect.top), bottom: round(copyRect.bottom) } : null,
      tables,
      overflowing: overflowing.slice(0, 8),
      still: stillRect ? { left: round(stillRect.left), right: round(stillRect.right), width: round(stillRect.width) } : null,
    }
  })()`)
  console.log(`${label}: экран ${data.vw}×${data.vh}, страница ${data.pageScroll}`)
  if (data.copy) {
    console.log(`   лист кадра: ${data.copy.width} px, x ${data.copy.left}..${data.copy.right}`)
  }
  for (const table of data.tables) {
    console.log(
      `   таблица: строк ${table.rows}, ширина ${table.clientWidth} (нужно ${table.scrollWidth}), ` +
        `колонки ${table.columns.join(' / ')} — ` +
        (table.scrollWidth > table.clientWidth + 1 ? 'есть своя прокрутка' : 'помещается'),
    )
  }
  if (data.still) console.log(`   картинка кадра: ${data.still.width} px, x ${data.still.left}..${data.still.right}`)
  console.log(
    `   части листа: всего ${data.parts.copyH}, область текста ${data.parts.scrollH}, ` +
      `заголовок ${data.parts.titleH}, кнопки ${data.parts.navH}, текст с ${data.parts.bodyTop} высотой ${data.parts.bodyH}`,
  )
  // Текст должен хотя бы НАЧИНАТЬСЯ в области текста: если bodyTop больше её высоты, человек
  // видит только заголовок с кнопками и ни строчки кадра.
  if (data.parts.bodyH > 0 && data.parts.bodyTop >= data.parts.scrollH) {
    console.warn(
      `${label}: ВНИМАНИЕ — текст начинается на ${data.parts.bodyTop} px, а область текста всего ${data.parts.scrollH} px`,
    )
  }
  if (data.overflowing.length > 0) {
    console.log('   вылезает за лист:')
    for (const item of data.overflowing) console.log(`     ${item}`)
  }
  return data
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }
  const created = await (await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика кадра на телефоне', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id

  try {
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    const editors = page.locator('[data-project-tab="editors"]')
    await editors.waitFor({ state: 'visible', timeout: 30_000 })
    await editors.click()
    const row = page.locator('.ed-row').first()
    await row.waitFor({ state: 'visible', timeout: 45_000 })
    await row.click()
    await page.getByPlaceholder('Заголовок события').fill(TITLE)
    await page.locator('.ed-editor textarea').first().fill(BODY)
    await page.waitForTimeout(1200)

    // Смотрим кадр: вкладка «Проект» показывает стадию с выбранным кадром.
    const project = page.locator('[data-project-tab="project"]')
    await project.waitFor({ state: 'visible', timeout: 20_000 })
    await project.click()
    await page.locator('.sf-copy').waitFor({ state: 'visible', timeout: 30_000 })

    // 1. Телефон в режиме полной версии: layout viewport как у десктопа, экран физически узкий.
    await page.setViewportSize({ width: 980, height: 2050 })
    await page.waitForTimeout(600)
    const desktopMode = await measure(page, 'полная версия на телефоне, 980×2050')
    if (desktopMode.pageScroll > desktopMode.vw + 1) {
      problems.push(`полная версия: горизонтальная прокрутка страницы ${desktopMode.pageScroll} > ${desktopMode.vw}`)
    }
    if (desktopMode.copy && desktopMode.copy.right > desktopMode.vw + 1) {
      problems.push(`полная версия: лист кадра выходит за экран (${desktopMode.copy.right} > ${desktopMode.vw})`)
    }
    for (const table of desktopMode.tables) {
      if (table.right > (desktopMode.copy?.right ?? 0) + 1) {
        problems.push('полная версия: таблица выходит за лист кадра')
      }
    }
    if (desktopMode.overflowing.length > 0) {
      problems.push(`полная версия: ${desktopMode.overflowing.length} элементов вылезают за лист`)
    }
    await page.screenshot({ path: '..\\_dev_shots\\stage-phone-desktop-mode.png', fullPage: false })

    // 3. Телефон в полной версии, повёрнутый набок (0.97.8): правило плитки не должно
    // зависеть только от портретной ориентации — иначе в ландшафте текст снова ложится на
    // картинку без подложки.
    await page.setViewportSize({ width: 980, height: 470 })
    await page.waitForTimeout(600)
    const landscape = await measure(page, 'полная версия, 980×470 (ландшафт)')
    if (landscape.pageScroll > landscape.vw + 1) {
      problems.push(`ландшафт: горизонтальная прокрутка страницы ${landscape.pageScroll} > ${landscape.vw}`)
    }
    if (landscape.copy && landscape.copy.right > landscape.vw + 1) {
      problems.push(`ландшафт: лист кадра выходит за экран (${landscape.copy.right} > ${landscape.vw})`)
    }
    for (const table of landscape.tables) {
      if (table.right > (landscape.copy?.right ?? 0) + 1) {
        problems.push('ландшафт: таблица выходит за лист кадра')
      }
    }
    const sheetBackground = (await page.evaluate(
      `(async () => { const copy = document.querySelector('.sf-copy'); return copy ? getComputedStyle(copy).backgroundColor : '' })()`,
    )) as string
    console.log(`ландшафт: фон листа ${sheetBackground}`)
    // Прозрачный фон — это и есть «текст поверх картинки»: у плитки он непрозрачный.
    if (sheetBackground === 'rgba(0, 0, 0, 0)' || sheetBackground === 'transparent') {
      problems.push('ландшафт: у листа кадра прозрачный фон — текст лежит прямо на иллюстрации')
    }
    await page.screenshot({ path: '..\\_dev_shots\\stage-phone-landscape.png', fullPage: false })

    // 2. Обычный телефон: тот же кадр в мобильной раскладке — для сравнения.
    await page.setViewportSize({ width: 360, height: 800 })
    await page.waitForTimeout(600)
    const phone = await measure(page, 'телефон, 360×800')
    if (phone.pageScroll > phone.vw + 1) {
      problems.push(`телефон: горизонтальная прокрутка страницы ${phone.pageScroll} > ${phone.vw}`)
    }
    if (phone.overflowing.length > 0) {
      problems.push(`телефон: ${phone.overflowing.length} элементов вылезают за лист`)
    }
    await page.screenshot({ path: '..\\_dev_shots\\stage-phone-mobile.png', fullPage: false })
  } finally {
    const removed = await page.request.delete(`${API}/api/projects/${projectId}`, { headers })
    console.log(`уборка: проект удалён (${removed.status()})`)
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимки: stage-phone-desktop-mode.png, stage-phone-mobile.png')
}

await main()
