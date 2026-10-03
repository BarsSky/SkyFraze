// Разовая проверка шапки на мобильной ширине: какие пункты меню человек реально видит
// и не уезжает ли шапка за край экрана. Пишется отдельным скриптом, потому что полный
// раннер аудита проверяет десятки экранов, а здесь нужен один ответ на один вопрос.
//
//   npx tsx tests/header-mobile-check.ts [baseUrl]

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost'
const EMAIL = 'galactic.test@e.com'
const PASSWORD = 'hunter22!'

const VIEWPORTS = [
  { width: 390, height: 844, tag: 'mobile' },
  { width: 320, height: 568, tag: 'mobile-small' },
  { width: 768, height: 1024, tag: 'tablet' },
]

const browser = await chromium.launch()
let failed = false

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()

  // Вход: без него «Мои проекты» и не должна показываться (она только для вошедших).
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 15_000 })
  // Ждём именно шапку: после смены URL React рисует её не мгновенно, и проверка
  // «до отрисовки» отвечает «пунктов нет» там, где меню просто ещё не появилось.
  await page.waitForSelector('header', { timeout: 15_000 })
  await page.waitForTimeout(300)

  const report = await page.evaluate(() => {
    const header = document.querySelector('header')
    const links = Array.from(document.querySelectorAll('.auth-links a')).map((a) => {
      const rect = a.getBoundingClientRect()
      const style = getComputedStyle(a)
      return {
        label: (a.textContent ?? '').trim(),
        visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
      }
    })
    return {
      links,
      // Если пунктов не нашлось — показываем, что вообще есть в шапке: обычно это
      // значит, что селектор устарел, а не что меню пустое.
      headerHTML: header ? (header as HTMLElement).outerHTML.slice(0, 1200) : '(нет <header>)',
      allLinks: Array.from(document.querySelectorAll('a')).map(
        (a) => `${a.className}|${a.getAttribute('href')}`,
      ),
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      headerScrollWidth: header ? header.scrollWidth : 0,
      headerClientWidth: header ? header.clientWidth : 0,
    }
  })

  if (report.links.length === 0) {
    console.log(`\n=== ${vp.tag} ${vp.width}×${vp.height} ===`)
    console.log('  пунктов .auth-links a не нашлось — вот что в шапке:')
    console.log(report.headerHTML)
    console.log(`  все ссылки страницы: ${report.allLinks.join(' , ')}`)
  }

  console.log(`\n=== ${vp.tag} ${vp.width}×${vp.height} ===`)
  for (const link of report.links) {
    console.log(
      `  ${link.visible ? '✔' : '✘'} ${link.label.padEnd(14)} ширина ${String(link.width).padStart(4)}px, высота ${link.height}px, правый край ${link.right}px${link.visible ? '' : '  ← СКРЫТА'}`,
    )
  }
  const overflow = report.docScrollWidth > report.docClientWidth
  console.log(
    `  документ: ${report.docScrollWidth} против ${report.docClientWidth} → ${overflow ? 'ЕСТЬ горизонтальный скролл' : 'по ширине влезает'}`,
  )
  const projects = report.links.find((l) => l.label === 'Мои проекты')
  if (!projects?.visible) {
    console.log('  ❌ «Мои проекты» не видны в меню')
    failed = true
  }
  if (overflow) {
    console.log('  ❌ шапка расширяет документ (на телефоне это уводит фиксированные слои)')
    failed = true
  }
  const small = report.links.filter((l) => l.visible && l.height < 32)
  if (small.length > 0) {
    console.log(`  ❌ мелкие цели нажатия: ${small.map((l) => `${l.label} ${l.height}px`).join(', ')}`)
    failed = true
  }
  await ctx.close()
}

await browser.close()
console.log(failed ? '\nИТОГ: есть дефекты' : '\nИТОГ: шапка в порядке')
process.exit(failed ? 1 : 0)
