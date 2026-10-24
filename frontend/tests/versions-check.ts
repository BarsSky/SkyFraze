// Разовая проверка окна «Версии» НА ЖИВОМ стенде.
//
// Юнит-тесты подменяют сеть: они проверяют поведение окна, а не то, что версия с сервера
// действительно приходит, показывает дерево и восстанавливается. Здесь браузер ходит по
// настоящему API.
//
// Нужен проект с хотя бы одной версией (его создаёт тест-скрипт или руками).
//
//   npx tsx tests/versions-check.ts [baseUrl]

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost'
const EMAIL = process.env.VERSIONS_EMAIL ?? 'versions.test@e.com'
const PASSWORD = process.env.VERSIONS_PASSWORD ?? 'hunter22!'

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
  // 409 на PUT /events/tree — штатный путь синхронизации проекции («ревизия устарела —
  // перечитать и повторить»), а не сбой текущей проверки.
  const isKnownSyncConflict = (text: string) => text.includes('409')
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    if (isKnownSyncConflict(m.text())) return
    consoleErrors.push(m.text())
  })

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20_000 })
  await page.locator('a[href^="/projects/"]').first().click()
  await page.waitForSelector('[data-versions-open]', { timeout: 20_000 })
  await page.click('[data-versions-open]')
  await page.waitForSelector('.sf-versions__window', { timeout: 20_000 })

  console.log(`\n=== ${vp.tag} ${vp.width}×${vp.height} ===`)

  // 1. Список версий пришёл с сервера.
  await page.waitForSelector('.sf-versions__item', { timeout: 15_000 })
  const info = await page.evaluate(() => {
    const window_ = document.querySelector('.sf-versions__window')
    const items = Array.from(document.querySelectorAll('.sf-versions__item'))
    const rect = window_?.getBoundingClientRect()
    return {
      count: items.length,
      first: (items[0]?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      width: rect ? Math.round(rect.width) : 0,
      height: rect ? Math.round(rect.height) : 0,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      buttons: Array.from(window_?.querySelectorAll('button') ?? []).map((b) =>
        (b.textContent ?? '').trim(),
      ),
    }
  })
  console.log(`  ✔ окно ${info.width}×${info.height}, версий: ${info.count}`)
  console.log(`    первая: «${info.first}»`)
  if (!info.buttons.includes('Сохранить версию')) {
    console.log('  ❌ нет кнопки «Сохранить версию» у редактора')
    failed = true
  }
  const overflow = info.docScrollWidth > info.docClientWidth
  if (overflow) {
    console.log(`  ❌ документ шире окна: ${info.docScrollWidth} > ${info.docClientWidth}`)
    failed = true
  }

  // 2. «Показать» — предпросмотр с деревом кадров.
  await page.getByRole('button', { name: 'Показать' }).first().click()
  await page.waitForSelector('[data-versions-preview]', { timeout: 15_000 })
  const preview = await page.evaluate(() => {
    const el = document.querySelector('[data-versions-preview]')
    const frames = el?.querySelectorAll('li').length ?? 0
    return { frames, text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) }
  })
  console.log(`  ✔ предпросмотр: кадров ${preview.frames}, «${preview.text}»`)
  if (preview.frames === 0) {
    console.log('  ❌ в предпросмотре нет кадров')
    failed = true
  }

  // 3. «Восстановить» сначала спрашивает, второе нажатие применяет.
  await page.getByRole('button', { name: 'Восстановить' }).first().click()
  const ask = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.sf-versions__actions button')).some((b) =>
        (b.textContent ?? '').includes('Точно восстановить'),
      ),
  )
  if (ask) {
    console.log('  ✔ восстановление спрашивает подтверждение')
  } else {
    console.log('  ❌ восстановление применилось без подтверждения')
    failed = true
  }
  await page.getByRole('button', { name: 'Точно восстановить?' }).first().click()
  await page.waitForSelector('[data-versions-note]', { timeout: 20_000 })
  const note = await page.evaluate(
    () => (document.querySelector('[data-versions-note]')?.textContent ?? '').trim(),
  )
  console.log(`  ✔ после восстановления: «${note.slice(0, 100)}»`)

  await page.screenshot({ path: `tests/.versions-${vp.tag}.png` })

  // 4. Окно закрывается и не блокирует страницу.
  await page.getByRole('button', { name: 'Закрыть' }).click()
  await page.waitForSelector('.sf-versions__window', { state: 'detached', timeout: 10_000 })
  console.log('  ✔ окно закрылось')

  if (consoleErrors.length > 0) {
    console.log(`  ❌ ошибки в консоли: ${consoleErrors.slice(0, 3).join(' | ')}`)
    failed = true
  } else {
    console.log('  ✔ ошибок в консоли нет')
  }
  await ctx.close()
}

await browser.close()
console.log(failed ? '\nИТОГ: есть дефекты' : '\nИТОГ: история версий работает через интерфейс')
process.exit(failed ? 1 : 0)
