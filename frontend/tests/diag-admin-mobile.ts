/**
 * Живая проверка страницы «Админка» на телефоне (0.99.0).
 *
 * Отчёт: «мобильная версия не до конца позволяет отобразить всё: прокручивая вниз в Админке, поле
 * „Пользователи“ частично за экраном, и его никак не достать».
 *
 * Проверяем то, что чувствует палец: можно ли прокрутить до конца, влезает ли каждый блок в экран,
 * не перекрывает ли низ что-то фиксированное (кнопка помощника, меню) и не «съедает» ли высоту
 * собственный скролл контейнера.
 *
 * Запуск: cd frontend && npx tsx tests/diag-admin-mobile.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const WIDTHS = (process.env.WIDTHS ?? '320,360,390,412,430').split(',').map(Number)

async function main() {
  const browser = await chromium.launch()
  const problems: string[] = []

  const loginContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const loginPage = await loginContext.newPage()
  await loginPage.goto(`${BASE}/login`)
  await loginPage.getByPlaceholder('email').fill(EMAIL)
  await loginPage.getByPlaceholder('пароль').fill(PASSWORD)
  await loginPage.getByRole('button', { name: /Войти/ }).click()
  await loginPage.waitForURL(/\/projects$/, { timeout: 20_000 })
  const storageState = await loginContext.storageState()
  await loginContext.close()

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      hasTouch: true,
      isMobile: true,
      storageState,
    })
    const page = await context.newPage()
    await page.goto(`${BASE}/admin`)
    await page.waitForTimeout(1200)

    const report = (await page.evaluate(`(async () => {
      const round = (value) => Math.round(value)
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Кто прокручивается: страница или вложенный контейнер.
      const scrollers = []
      let scroller = null
      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node)
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
          scrollers.push(node.tagName.toLowerCase() + '.' + (typeof node.className === 'string' ? node.className.slice(0, 28) : '') + ' ' + node.clientHeight + '/' + node.scrollHeight)
          if (!scroller) scroller = node
        }
      }
      const target = scroller || document.scrollingElement
      target.scrollTop = target.scrollHeight
      const scrolled = target.scrollTop
      // Что видно в самом низу после прокрутки до конца.
      const users = document.querySelector('.admin__users')
      const usersBox = users ? users.getBoundingClientRect() : null
      // Последняя строка списка — то, что «не достаётся»: после прокрутки до конца она обязана быть
      // внутри экрана. Верх всего списка при этом естественно уходит вверх — это не дефект.
      const lastRow = users && users.lastElementChild ? users.lastElementChild.getBoundingClientRect() : null
      // Фиксированные слои, которые могут закрывать низ экрана.
      const fixed = []
      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node)
        if (style.position !== 'fixed') continue
        const box = node.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        if (box.bottom > vh - 120 && box.top < vh) {
          fixed.push({
            cls: (node.tagName.toLowerCase() + '.' + (typeof node.className === 'string' ? node.className.slice(0, 32) : '')).slice(0, 60),
            box: { top: round(box.top), bottom: round(box.bottom), left: round(box.left), right: round(box.right) },
          })
        }
      }
      // Шире ли экрана что-нибудь — таблица пользователей любит так делать.
      const wide = []
      for (const node of document.querySelectorAll('body *')) {
        const box = node.getBoundingClientRect()
        if (box.width === 0) continue
        if (box.right > vw + 1 && getComputedStyle(node).position !== 'fixed') {
          wide.push((node.tagName.toLowerCase() + '.' + (typeof node.className === 'string' ? node.className.slice(0, 32) : '')).slice(0, 60) + ' ' + round(box.left) + '..' + round(box.right))
        }
      }
      return {
        vw,
        vh,
        scrollers,
        scroller: target === document.scrollingElement ? 'window' : target.tagName.toLowerCase(),
        scrolled: round(scrolled),
        maxScroll: round(target.scrollHeight - target.clientHeight),
        users: usersBox ? { top: round(usersBox.top), bottom: round(usersBox.bottom), height: round(usersBox.height) } : null,
        lastRow: lastRow ? { top: round(lastRow.top), bottom: round(lastRow.bottom), height: round(lastRow.height) } : null,
        fixed: fixed.slice(0, 6),
        wide: wide.slice(0, 8),
        pageScroll: document.documentElement.scrollWidth,
      }
    })()`)) as {
      vw: number
      vh: number
      scrollers: string[]
      scroller: string
      scrolled: number
      maxScroll: number
      users: { top: number; bottom: number; height: number } | null
      lastRow: { top: number; bottom: number; height: number } | null
      fixed: Array<{ cls: string; box: { top: number; bottom: number; left: number; right: number } }>
      wide: string[]
      pageScroll: number
    }

    console.log(`\n=== ${width}×800`)
    console.log(`прокрутка (${report.scroller}): прошли ${report.scrolled} из ${report.maxScroll}`)
    for (const line of report.scrollers) console.log(`   свой скролл: ${line}`)
    if (report.users) {
      console.log(`блок пользователей: top ${report.users.top}, bottom ${report.users.bottom}, высота ${report.users.height}`)
    }
    for (const item of report.fixed) {
      console.log(`фиксированный слой у низа: ${item.cls} — ${item.box.top}..${item.box.bottom}`)
    }
    for (const item of report.wide) console.log(`шире экрана: ${item}`)

    if (report.pageScroll > report.vw + 1) problems.push(`${width}px: страница шире экрана — ${report.pageScroll} > ${report.vw}`)
    if (report.maxScroll > 0 && report.scrolled < report.maxScroll - 2) {
      problems.push(`${width}px: до конца не прокручивается — ${report.scrolled} из ${report.maxScroll}`)
    }
    if (report.users && report.lastRow) {
      console.log(
        `последняя строка списка: top ${report.lastRow.top}, bottom ${report.lastRow.bottom} при экране ${report.vh}`,
      )
      // Главная жалоба: до последних строк не добраться. После прокрутки до конца последняя строка
      // обязана быть целиком внутри экрана — и не под фиксированным слоем.
      if (report.lastRow.bottom > report.vh + 1) {
        problems.push(
          `${width}px: последняя строка списка уходит за низ экрана (${report.lastRow.bottom} при ${report.vh})`,
        )
      }
      if (report.lastRow.top < 0) {
        problems.push(`${width}px: последняя строка списка выше экрана (${report.lastRow.top})`)
      }
    }
    for (const item of report.fixed) {
      if (report.users && item.box.top < report.users.bottom && item.box.bottom > report.users.top) {
        problems.push(`${width}px: блок пользователей перекрыт фиксированным слоем ${item.cls}`)
      }
    }
    for (const item of report.wide) problems.push(`${width}px: за край экрана выходит ${item}`)

    await page.screenshot({ path: `..\\_dev_shots\\admin-${width}.png` })
    await context.close()
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('\nпроблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('\nпроблемы: нет')
}

await main()
