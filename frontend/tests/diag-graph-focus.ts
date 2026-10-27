/**
 * Живая проверка графа связей после 0.84.0:
 *
 *   · нажатие на карточку — «перелёт» в центр: карточка со значениями видна СРАЗУ, а центр
 *     графа переключается через ~320 мс;
 *   · раскрытая карточка стоит в центре холста и не вылезает за него;
 *   · линия связи РВЁТСЯ там, где стоит подпись: считаем зазор между концом первой половины
 *     ребра и началом второй, и проверяем, что подпись не пересекает ни одну половину.
 *
 * Запуск: cd frontend && npx tsx tests/diag-graph-focus.ts
 * Снимки: _dev_shots/focus-*.png (до клика, середина перелёта, после).
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
}

/** Геометрия одного ребра: две половины, разрыв, подпись и её пересечения с линиями. */
const EDGE_GEOMETRY = `
  var groups = Array.from(document.querySelectorAll('[data-entity-graph-edge]'))
  function segDistance(p, a, b) {
    var vx = b.x - a.x, vy = b.y - a.y
    var len2 = vx * vx + vy * vy
    var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
    var dx = p.x - (a.x + t * vx), dy = p.y - (a.y + t * vy)
    return Math.sqrt(dx * dx + dy * dy)
  }
  return groups.map(function (g) {
    var lines = Array.from(g.querySelectorAll('line'))
    var text = g.querySelector('text')
    if (lines.length < 2 || !text) return { pieces: lines.length, missing: true }
    var a = lines[0], b = lines[1]
    var p1 = { x: +a.getAttribute('x2'), y: +a.getAttribute('y2') }
    var p2 = { x: +b.getAttribute('x1'), y: +b.getAttribute('y1') }
    var box = text.getBBox()
    var gap = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y))
    // Ближайшее расстояние от прямоугольника подписи до каждой половины линии.
    var corners = [
      { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
      { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ]
    function clearOf(line) {
      var la = { x: +line.getAttribute('x1'), y: +line.getAttribute('y1') }
      var lb = { x: +line.getAttribute('x2'), y: +line.getAttribute('y2') }
      var min = Infinity
      corners.forEach(function (c) { min = Math.min(min, segDistance(c, la, lb)) })
      return Math.round(min)
    }
    return {
      pieces: lines.length,
      label: text.textContent,
      gap: Math.round(gap),
      labelW: Math.round(box.width),
      labelH: Math.round(box.height),
      clearanceFromFirst: clearOf(a),
      clearanceFromSecond: clearOf(b),
    }
  })
`

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })

  await signIn(page)
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  const tab = page.locator('[data-project-tab="relations"]')
  await tab.waitFor({ state: 'visible', timeout: 45_000 })
  await tab.click()
  await page.locator('[data-entity-graph-canvas]').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1200)

  const edges = await evalIn<Array<Record<string, unknown>>>(page, EDGE_GEOMETRY)
  console.log('рёбра:', JSON.stringify(edges))
  if (edges.length === 0) problems.push('у проекта нет ни одного ребра — проверять разрыв не на чем')
  for (const edge of edges) {
    if ((edge.pieces as number) !== 2) problems.push(`ребро «${edge.label}»: линия не разорвана`)
    // Критерий не «разрыв шире подписи»: у вертикальной связи подпись ложится ПОПЕРЁК линии, и
    // достаточно, чтобы разрыв накрыл её высоту. Смотрим ещё и фактический зазор до линии.
    if ((edge.gap as number) + 1 < (edge.labelH as number)) {
      problems.push(`ребро «${edge.label}»: разрыв ${edge.gap} px ниже высоты подписи ${edge.labelH} px`)
    }
    if (((edge.clearanceFromFirst as number) ?? 0) < 1 || ((edge.clearanceFromSecond as number) ?? 0) < 1) {
      problems.push(`ребро «${edge.label}»: подпись касается линии`)
    }
  }

  const graph = page.locator('[data-entity-graph-canvas]')
  await graph.screenshot({ path: `${OUT}\\focus-before.png` })

  const centerBefore = await page.locator('[data-entity-graph-center]').innerText()
  const neighbor = page.locator('[data-entity-graph-node]').first()
  const neighborName = await neighbor.innerText()
  if ((await page.locator('[data-entity-graph-node]').count()) === 0) {
    problems.push('у центральной карточки нет соседей — перелёт проверить не на чем')
  }

  await neighbor.click()
  // Сразу после клика: карточка уже раскрыта, «пилюля» летит.
  const atOnce = await evalIn<Record<string, unknown>>(
    page,
    `
    var card = document.querySelector('[data-entity-graph-card]')
    var fly = document.querySelector('[data-entity-graph-fly]')
    return {
      cardVisible: !!card && card.getBoundingClientRect().width > 0,
      cardText: card ? card.innerText.slice(0, 120) : '',
      flying: !!fly,
      center: document.querySelector('[data-entity-graph-center]').innerText,
    }
    `,
  )
  console.log('через 0 мс после клика:', JSON.stringify({ ...atOnce, cardText: undefined }))
  await page.waitForTimeout(120)
  await graph.screenshot({ path: `${OUT}\\focus-mid.png` })

  await page.waitForTimeout(420)
  const after = await evalIn<Record<string, unknown>>(
    page,
    `
    var card = document.querySelector('[data-entity-graph-card]')
    var canvas = document.querySelector('[data-entity-graph-canvas]')
    var center = document.querySelector('[data-entity-graph-center]')
    if (!card || !canvas || !center) return { missing: true }
    var c = card.getBoundingClientRect()
    var k = canvas.getBoundingClientRect()
    return {
      center: center.innerText,
      flying: !!document.querySelector('[data-entity-graph-fly]'),
      card: { w: Math.round(c.width), h: Math.round(c.height) },
      // Середина карточки против середины холста: раскрытая карточка должна стоять по центру.
      offsetX: Math.round(c.left + c.width / 2 - (k.left + k.width / 2)),
      offsetY: Math.round(c.top + c.height / 2 - (k.top + k.height / 2)),
      insideCanvas: c.left >= k.left - 1 && c.right <= k.right + 1 && c.top >= k.top - 1 && c.bottom <= k.bottom + 1,
      aliases: (document.querySelector('[data-entity-graph-card-aliases]') || {}).innerText || '',
      links: document.querySelectorAll('[data-entity-graph-card-links] li').length,
    }
    `,
  )
  console.log('через 540 мс:', JSON.stringify(after))
  await graph.screenshot({ path: `${OUT}\\focus-after.png` })

  const atOnceRec = atOnce as { cardVisible?: boolean; flying?: boolean }
  const afterRec = after as {
    center?: string
    flying?: boolean
    offsetX?: number
    offsetY?: number
    insideCanvas?: boolean
    links?: number
    aliases?: string
    missing?: boolean
  }
  if (!atOnceRec.cardVisible) problems.push('карточка не раскрылась сразу после клика — значения не видны во время перехода')
  if (!atOnceRec.flying) problems.push('нет перелетающей «пилюли»: переход не анимирован')
  if (afterRec.missing) {
    problems.push('после перехода карточка исчезла')
  } else {
    if (afterRec.flying) problems.push('«пилюля» осталась после перелёта')
    if (afterRec.center !== neighborName) {
      problems.push(`центр не переключился: было «${centerBefore}», кликнули «${neighborName}», стало «${afterRec.center}»`)
    }
    if (Math.abs(afterRec.offsetX ?? 99) > 4 || Math.abs(afterRec.offsetY ?? 99) > 4) {
      problems.push(`карточка не в центре холста: смещение ${afterRec.offsetX}×${afterRec.offsetY} px`)
    }
    if (afterRec.insideCanvas === false) problems.push('карточка выходит за холст')
    if ((afterRec.links ?? 0) === 0) problems.push('в карточке нет списка связей — значения не развёрнуты')
  }

  // «Назад» возвращает прежний центр и убирает карточку.
  await page.locator('[data-entity-graph-back]').click()
  await page.waitForTimeout(400)
  const back = await evalIn<Record<string, unknown>>(
    page,
    `
    return {
      center: document.querySelector('[data-entity-graph-center]').innerText,
      card: !!document.querySelector('[data-entity-graph-card]'),
    }
    `,
  )
  console.log('после «назад»:', JSON.stringify(back))
  if ((back as { center?: string }).center !== centerBefore) {
    problems.push(`«назад» не вернул прежний центр: ${(back as { center?: string }).center}`)
  }
  if ((back as { card?: boolean }).card) problems.push('«назад» оставил карточку открытой')

  await page.waitForTimeout(200)
  await page.locator('[data-entity-graph-center]').click()
  await page.waitForTimeout(250)
  await graph.screenshot({ path: `${OUT}\\focus-center-card.png` })
  const centerCard = await evalIn<Record<string, unknown>>(
    page,
    `
    var card = document.querySelector('[data-entity-graph-card]')
    var canvas = document.querySelector('[data-entity-graph-canvas]')
    if (!card || !canvas) return { missing: true }
    var c = card.getBoundingClientRect(), k = canvas.getBoundingClientRect()
    return {
      offsetX: Math.round(c.left + c.width / 2 - (k.left + k.width / 2)),
      links: document.querySelectorAll('[data-entity-graph-card-links] li').length,
    }
    `,
  )
  console.log('карточка центра:', JSON.stringify(centerCard))
  if ((centerCard as { missing?: boolean }).missing) problems.push('нажатие на центральный узел не раскрыло карточку')

  // Телефон 390 px: карточка в центре закрыла бы весь граф, поэтому там она — «лист» снизу.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 780 } })
  mobile.on('pageerror', (e) => problems.push(`mobile pageerror: ${e.message}`))
  mobile.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`mobile console: ${msg.text()}`)
  })
  await signIn(mobile)
  await mobile.goto(`${BASE}/projects/${PROJECT_ID}`)
  const mobileTab = mobile.locator('[data-project-tab="relations"]')
  await mobileTab.waitFor({ state: 'visible', timeout: 45_000 })
  await mobileTab.click()
  await mobile.locator('[data-entity-graph-canvas]').waitFor({ state: 'visible', timeout: 20_000 })
  await mobile.waitForTimeout(900)
  await mobile.locator('[data-entity-graph-node]').first().click()
  await mobile.waitForTimeout(600)
  const phone = await evalIn<Record<string, unknown>>(
    mobile,
    `
    var card = document.querySelector('[data-entity-graph-card]')
    var canvas = document.querySelector('[data-entity-graph-canvas]')
    var doc = document.documentElement
    if (!card || !canvas) return { missing: true }
    var c = card.getBoundingClientRect(), k = canvas.getBoundingClientRect()
    var lastLink = document.querySelector('[data-entity-graph-card-links] li:last-child')
    var scrollClip = card.scrollHeight - card.clientHeight
    return {
      card: { w: Math.round(c.width), h: Math.round(c.height), bottomGap: Math.round(k.bottom - c.bottom) },
      canvas: { w: Math.round(k.width) },
      sheet: Math.abs(c.width - (k.width - 16)) <= 2,
      horizontal: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
      links: document.querySelectorAll('[data-entity-graph-card-links] li').length,
      // Обрезан ли текст: остаток прокрутки внутри карточки и выход строки за её низ.
      scrollClip: Math.round(scrollClip),
      lastLinkOverflow: lastLink ? Math.round(lastLink.getBoundingClientRect().bottom - c.bottom) : null,
    }
    `,
  )
  console.log('телефон 390:', JSON.stringify(phone))
  await mobile.locator('[data-entity-graph-canvas]').screenshot({ path: `${OUT}\\focus-mobile.png` })
  const phoneRec = phone as {
    missing?: boolean
    sheet?: boolean
    horizontal?: number
    links?: number
    card?: { bottomGap?: number }
    scrollClip?: number
    lastLinkOverflow?: number | null
  }
  if (phoneRec.missing) problems.push('на телефоне карточка не раскрылась')
  if (phoneRec.sheet === false) problems.push('на телефоне карточка не стала «листом» снизу холста')
  if ((phoneRec.card?.bottomGap ?? 99) !== 8) {
    problems.push(`на телефоне карточка не прижата к низу холста: отступ ${phoneRec.card?.bottomGap} px`)
  }
  if ((phoneRec.horizontal ?? 0) > 0) problems.push(`на телефоне горизонтальное переполнение ${phoneRec.horizontal} px`)
  if ((phoneRec.links ?? 0) === 0) problems.push('на телефоне в карточке нет списка связей')
  if ((phoneRec.lastLinkOverflow ?? 0) > 0) {
    problems.push(`на телефоне содержимое карточки вышло за её низ на ${phoneRec.lastLinkOverflow} px`)
  }
  await mobile.close()

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет')
}

await main()
