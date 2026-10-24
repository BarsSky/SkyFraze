// Разовая проверка «предложенных правок» НА ЖИВОМ стенде (фаза 6).
//
// Юнит-тесты панели подменяют сеть целиком: они проверяют поведение, а не то, что
// применение правки действительно доезжает до документа. Здесь браузер ходит по
// настоящему API: предложение берётся с сервера, кнопка «Применить» пишет в проект,
// «Вернуть» возвращает прежний текст.
//
// Предложение должно существовать заранее (его создаёт агент или тест через базу) —
// скрипт его только применяет и возвращает.
//
//   npx tsx tests/proposal-check.ts [baseUrl]

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost'
const EMAIL = process.env.PROPOSAL_EMAIL ?? 'phase6.test@e.com'
const PASSWORD = process.env.PROPOSAL_PASSWORD ?? 'hunter22!'
// Что должно появиться в кадре после применения (подстрока нового текста).
const EXPECT = process.env.PROPOSAL_EXPECT ?? 'Новый текст главы'

const VIEWPORTS = [
  { width: 1280, height: 900, tag: 'desktop' },
  { width: 390, height: 844, tag: 'mobile' },
]

const browser = await chromium.launch()
let failed = false

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20_000 })
  await page.locator('a[href^="/projects/"]').first().click()
  await page.waitForSelector('[data-assistant-fab]', { timeout: 20_000 })
  await page.click('[data-assistant-fab]')
  await page.waitForSelector('[data-assistant-panel]', { timeout: 20_000 })

  console.log(`\n=== ${vp.tag} ${vp.width}×${vp.height} ===`)

  // Приводим стенд к состоянию «ждёт решения»: если правку уже применили (вторая ширина
  // или прошлый запуск), сначала возвращаем прежний текст — проверка должна повторяться.
  if ((await page.locator('[data-assistant-applied]').count()) > 0) {
    await page.getByRole('button', { name: 'Вернуть прежний текст' }).click()
    await page.waitForSelector('[data-assistant-proposals]', { timeout: 20_000 })
    console.log('  · правка была применена — вернул прежний текст и продолжаю')
  }

  // 1. Предложение пришло с сервера и показано отдельно от «изменений».
  await page.waitForSelector('[data-assistant-proposals]', { timeout: 15_000 })
  const block = await page.evaluate(() => {
    const el = document.querySelector('[data-assistant-proposals]')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text,
      hasApply: Array.from(el.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'Применить'),
      hasDiscard: Array.from(el.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'Отклонить'),
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }
  })
  if (block === null) {
    console.log('  ❌ блока «Предложенные правки» нет')
    failed = true
    await ctx.close()
    continue
  }
  console.log(`  ✔ блок: ${block.width}×${block.height}, «${block.text.slice(0, 90)}»`)
  if (!block.hasApply || !block.hasDiscard) {
    console.log('  ❌ нет кнопок «Применить»/«Отклонить»')
    failed = true
  }
  const overflow = block.docScrollWidth > block.docClientWidth
  if (overflow) {
    console.log(`  ❌ документ шире окна: ${block.docScrollWidth} > ${block.docClientWidth}`)
    failed = true
  }
  await page.screenshot({ path: `tests/.proposal-${vp.tag}.png` })

  // 2. Применяем — правка должна доехать до проекта.
  await page.getByRole('button', { name: 'Применить' }).click()
  await page.waitForSelector('[data-assistant-applied]', { timeout: 20_000 })
  const applied = await page.evaluate(() => {
    const el = document.querySelector('[data-assistant-applied]')
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  })
  console.log(`  ✔ применено: «${applied.slice(0, 90)}»`)

  // 3. Правка доехала до ДОКУМЕНТА, а не только до ответа API: перезагружаем страницу —
  // после перезагрузки редактор читает снапшот с сервера, а не то, что осталось в памяти.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-assistant-fab]', { timeout: 20_000 })
  const persisted = await page.evaluate(
    (needle) => document.body.innerText.includes(needle),
    EXPECT,
  )
  if (persisted) {
    console.log(`  ✔ после перезагрузки в проекте есть «${EXPECT}» (правка в документе)`)
  } else {
    console.log(`  ❌ после перезагрузки правки нет — она не доехала до документа`)
    failed = true
  }

  // 4. Возвращаем прежний текст: «Вернуть» есть только у перезаписи.
  await page.click('[data-assistant-fab]')
  await page.waitForSelector('[data-assistant-applied]', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Вернуть прежний текст' }).click()
  await page.waitForSelector('[data-assistant-proposals]', { timeout: 20_000 })
  console.log('  ✔ после «Вернуть» предложение снова ждёт решения')

  if (consoleErrors.length > 0) {
    console.log(`  ❌ ошибки в консоли: ${consoleErrors.slice(0, 3).join(' | ')}`)
    failed = true
  } else {
    console.log('  ✔ ошибок в консоли нет')
  }
  await ctx.close()
}

await browser.close()
console.log(failed ? '\nИТОГ: есть дефекты' : '\nИТОГ: предложенные правки работают через интерфейс')
process.exit(failed ? 1 : 0)
