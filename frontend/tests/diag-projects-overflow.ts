/**
 * Живая проверка страницы «Проекты» на телефоне (0.98.3).
 *
 * Отчёт: «не полностью отображаются: в мобильном режиме проекты уезжают за край экрана и не
 * прокручиваются выше». Проверяем числами: шире ли страница экрана, ЧТО именно выходит за край, и
 * можно ли вернуться наверх (у страницы не должно быть своей горизонтальной прокрутки и «залипшей»
 * вертикальной).
 *
 * Запуск: cd frontend && npx tsx tests/diag-projects-overflow.ts
 */
import { chromium, type Browser } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const WIDTHS = (process.env.WIDTHS ?? '320,360,390,412,430').split(',').map(Number)

type Overflow = {
  vw: number
  pageScroll: number
  bodyScroll: number
  offenders: Array<{ tag: string; cls: string; left: number; right: number; width: number; where: string }>
  clipped: Array<{ tag: string; cls: string; left: number; right: number; cardRight: number }>
  scroll: { name: string; before: number; top: number; canUp: boolean; docHeight: number; winHeight: number; headerBottom: number | null; firstCardTop: number | null; scrollers: string[] }
}

async function measure(browser: Browser, storageState: Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>, width: number, problems: string[]) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    hasTouch: true,
    isMobile: true,
    storageState,
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(1200)

  const data = (await page.evaluate(`(async () => {
    const round = (value) => Math.round(value)
    const vw = window.innerWidth
    const offenders = []
    for (const node of document.querySelectorAll('body *')) {
      const box = node.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (box.right <= vw + 1) continue
      // Фиксированные слои (кнопка помощника, панели) — не «уехавший контент».
      const style = getComputedStyle(node)
      if (style.position === 'fixed') continue
      const parent = node.parentElement
      offenders.push({
        tag: node.tagName.toLowerCase(),
        cls: typeof node.className === 'string' ? node.className.slice(0, 48) : '',
        left: round(box.left),
        right: round(box.right),
        width: round(box.width),
        where: parent ? parent.tagName.toLowerCase() + '.' + (typeof parent.className === 'string' ? parent.className.slice(0, 32) : '') : '',
      })
    }
    // Прокрутка: кто именно прокручивается и можно ли вернуться наверх. На этой странице
    // прокручивается не окно, а элемент main, поэтому «до дна и обратно» делаем именно ему.
    const scrollers = []
    let scroller = null
    for (const node of document.querySelectorAll('body *')) {
      const style = getComputedStyle(node)
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 4) {
        scrollers.push(node.tagName.toLowerCase() + '.' + (typeof node.className === 'string' ? node.className.slice(0, 32) : '') + ' ' + node.clientHeight + '/' + node.scrollHeight)
        if (!scroller) scroller = node
      }
    }
    const target = scroller || document.scrollingElement
    const before = target.scrollTop
    target.scrollTop = target.scrollHeight
    const bottom = target.scrollTop
    target.scrollTop = Math.max(0, Math.min(200, bottom))
    const afterUp = target.scrollTop
    target.scrollTop = 0
    // Первая карточка при прокрутке наверх: не прячется ли она под шапкой.
    const header = document.querySelector('.layout header')
    const headerBox = header ? header.getBoundingClientRect() : null
    const firstCard = document.querySelector('.list .card')
    const firstCardBox = firstCard ? firstCard.getBoundingClientRect() : null
    return {
      vw,
      pageScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      offenders: offenders.slice(0, 12),
      clipped: [...document.querySelectorAll('.list .card')].flatMap((card) => {
        const cardBox = card.getBoundingClientRect()
        return [...card.querySelectorAll('h3 a, .card__desc, .card__meta')].flatMap((node) => {
          const box = node.getBoundingClientRect()
          if (box.right <= cardBox.right + 1) return []
          return [{ tag: node.tagName.toLowerCase(), cls: typeof node.className === 'string' ? node.className.slice(0, 40) : '', left: round(box.left), right: round(box.right), cardRight: round(cardBox.right) }]
        })
      }),
      scroll: {
        name: target === document.scrollingElement ? 'window' : (target.tagName.toLowerCase() + '.' + (typeof target.className === 'string' ? target.className.slice(0, 24) : '')),
        before: round(before),
        top: round(bottom),
        canUp: afterUp < bottom,
        docHeight: target.scrollHeight,
        winHeight: target.clientHeight,
        headerBottom: headerBox ? round(headerBox.bottom) : null,
        firstCardTop: firstCardBox ? round(firstCardBox.top) : null,
        scrollers,
      },
    }
  })()`)) as Overflow

  console.log(`\n=== ${width}px`)
  console.log(`страница ${data.pageScroll}/${data.vw}, body ${data.bodyScroll}/${data.vw}`)
  console.log(`прокрутка (${data.scroll.name}): до ${data.scroll.top} px из ${data.scroll.docHeight} при окне ${data.scroll.winHeight}, вверх работает: ${data.scroll.canUp}`)
  console.log(`   шапка до ${data.scroll.headerBottom} px, первая карточка сверху ${data.scroll.firstCardTop} px`)
  for (const item of data.scroll.scrollers) console.log(`   свой скролл: ${item}`)
  if (data.pageScroll > data.vw + 1) problems.push(`${width}px: страница шире экрана — ${data.pageScroll} > ${data.vw}`)
  if (!data.scroll.canUp && data.scroll.top > 0) problems.push(`${width}px: со дна не прокручивается вверх`)
  if (data.scroll.headerBottom !== null && data.scroll.firstCardTop !== null && data.scroll.firstCardTop < data.scroll.headerBottom - 1) {
    problems.push(
      `${width}px: первая карточка уходит под шапку (её верх ${data.scroll.firstCardTop} px, низ шапки ${data.scroll.headerBottom} px)`,
    )
  }
  for (const item of data.clipped) {
    console.log(`   обрезано в карточке: ${item.tag}.${item.cls} — x до ${item.right}, край карточки ${item.cardRight}`)
    problems.push(`${width}px: содержимое карточки шире карточки (${item.tag}.${item.cls}: ${item.right} > ${item.cardRight}) — текст обрезан`)
  }
  if (data.offenders.length === 0) {
    console.log('за край не выходит ничего')
  } else {
    console.log(`за край выходит ${data.offenders.length} элементов:`)
    for (const item of data.offenders) {
      console.log(`   ${item.tag}.${item.cls} — x ${item.left}..${item.right} (${item.width} px), внутри ${item.where}`)
    }
  }
  await page.screenshot({ path: `..\\_dev_shots\\projects-${width}.png` })
  await context.close()
}

async function main() {
  const browser = await chromium.launch()
  const problems: string[] = []

  // Один вход на все ширины: у стенда ограничитель 5 попыток входа в минуту.
  const loginContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const loginPage = await loginContext.newPage()
  await loginPage.goto(`${BASE}/login`)
  await loginPage.getByPlaceholder('email').fill(EMAIL)
  await loginPage.getByPlaceholder('пароль').fill(PASSWORD)
  await loginPage.getByRole('button', { name: /Войти/ }).click()
  await loginPage.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await loginPage.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }
  const storageState = await loginContext.storageState()

  // Страница прокручивается только когда карточек много. Заводим их с «неудобным» содержимым:
  // длинное слово в названии без пробелов, длинное описание, опубликованная ссылка /s/… — всё это
  // обычно и растягивает карточку шире экрана.
  const created: string[] = []
  const seeds = [
    { title: 'МЕТАДАННЫЕКНИГИИИНДЕКСФАЙЛОВКАТАЛОГА', description: '> Навигация по всем материалам каталога «Galactic Story». ## Корневые файлы | файлы: 108 КБ из 10.0 МБ' },
    { title: 'Планета — АнуВаар', description: 'Краткое описание временных эпох развития флоры, фауны и местного населения этой планеты' },
    { title: 'Чёрное солнце', description: 'История про маяк, шторм и письмо из-за пролива' },
    { title: 'Индекс ссылок', description: 'https://fraze.skynas.ru/s/verylongslugwithoutanyspaces1234567890' },
    { title: 'Мир после шторма', description: 'Короткое описание' },
  ]
  try {
    for (const seed of seeds) {
      const response = await loginPage.request.post(`${BASE}/api/projects`, { headers, data: seed })
      const body = (await response.json()) as { project?: { id?: string }; id?: string }
      const id = body.project?.id ?? body.id
      if (id) created.push(id)
    }
    console.log(`создано проектов: ${created.length}`)

    for (const width of WIDTHS) {
      await measure(browser, storageState, width, problems)
    }
  } finally {
    for (const id of created) {
      await loginPage.request.delete(`${BASE}/api/projects/${id}`, { headers })
      await loginPage.request.delete(`${BASE}/api/projects/${id}/purge`, { headers })
    }
    console.log(`уборка: удалено проектов ${created.length}`)
  }

  await loginContext.close()
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
