/**
 * Живая проверка списка связей ПОД НАГРУЗКОЙ (0.97.3).
 *
 * 0.97.2 разделила связи на строки, но проверялась на пяти связях у карточки. Здесь — крайний
 * случай: у одной карточки 24 связи на 24 карточки с длинными именами. Смысл — измерить, что
 * список не превращает карточку в полотно: карточка не должна занимать несколько экранов, а её
 * кнопки («Изменить», «Связать») не должны уезжать на несколько прокруток вниз.
 *
 * Проект, карточки и связи создаются и удаляются скриптом — стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-entity-links-load.ts
 */
import { chromium } from 'playwright'
import type { Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

/** Главная карточка получит все связи: на ней и меряем высоту. */
const HUB = 'Аня Ветрова'
/** 20 карточек — ровно предел сервера (`maxLinksPerEntity`): больше у карточки не бывает. */
const OTHERS = [
  'Земля за проливом',
  'Сторож маяка на северном берегу',
  'Письмо из-за пролива, найденное в третью ночь',
  'Капитан парома «Святой Август»',
  'Трактир «Три весла» у нижней пристани',
  'Брат Ани, пропавший в море десять лет назад',
  'Старая карта течений с пометками отца',
  'Маячный смотритель, который не зажигает огонь',
  'Сестра милосердия при портовом лазарете',
  'Корабельный журнал «Святого Августа»',
  'Рыбацкая артель северного берега',
  'Хозяин лодочной станции на отмели',
  'Шкипер, который берёт пассажиров без документов',
  'Дом Ани на склоне у маяка',
  'Соседка, которая знает больше, чем говорит',
  'Письмо, отправленное двадцать лет назад',
  'Чайка, живущая на подоконнике Ани',
  'Морская соль вперемешку с пеплом',
  'Песня, которую поют только в шторм',
  'Шторм, случившийся в ночь исчезновения',
]
/** Карточка за пределом: её связь сервер обязан отклонить с понятным текстом. */
const OVER_LIMIT = 'Порт на материке, куда уходит паром'
const LABELS = ['живёт на', 'боится', 'нашла письмо от', 'принадлежит', 'упоминается в', 'знает про']

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
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }

  const created = await (await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика связей под нагрузкой', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id

  try {
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })

    const ids = new Map<string, string>()
    for (const name of [HUB, ...OTHERS, OVER_LIMIT]) {
      const response = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
        headers,
        data: { name, kind: 'character' },
      })
      if (response.status() !== 201) problems.push(`карточка «${name}»: ${response.status()}`)
      const body = (await response.json()) as { entity?: { id: string } }
      if (body.entity?.id) ids.set(name, body.entity.id)
    }
    for (const [index, name] of OTHERS.entries()) {
      const response = await page.request.post(
        `${API}/api/projects/${projectId}/entities/${ids.get(HUB)}/links`,
        { headers, data: { to: ids.get(name), label: LABELS[index % LABELS.length] } },
      )
      if (response.status() !== 201) problems.push(`связь с «${name}»: ${response.status()}`)
    }
    // Двадцать первая связь: предел должен быть отказом с объяснением, а не тишиной.
    const overLimit = await page.request.post(
      `${API}/api/projects/${projectId}/entities/${ids.get(HUB)}/links`,
      { headers, data: { to: ids.get(OVER_LIMIT), label: 'живёт на' } },
    )
    const overLimitText = overLimit.status() === 400 ? (await overLimit.text()).trim() : ''
    console.log(`двадцать первая связь: ${overLimit.status()} ${overLimitText.slice(0, 90)}`)
    if (overLimit.status() !== 400) {
      problems.push(`связь сверх предела не отклонена: ${overLimit.status()}`)
    } else if (!/связ/i.test(overLimitText)) {
      problems.push(`отказ сверх предела без объяснения: ${overLimitText.slice(0, 90)}`)
    }

    await page.reload()
    await page.goto(`${BASE}/projects/${projectId}`)
    const relationsTab = page.locator('[data-project-tab="relations"]')
    await relationsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await relationsTab.click()
    const entityPanel = page.locator('details.ent')
    await entityPanel.waitFor({ state: 'attached', timeout: 20_000 })
    if (!(await entityPanel.evaluate((node: HTMLDetailsElement) => node.open))) {
      await entityPanel.locator('summary').first().click()
    }

    const measure = async (target: Page, label: string, viewportWidth: number, compact: boolean) => {
      const data = await target.evaluate<{
        rows: number
        rowHeight: number
        firstRow: string
        cardHeight: number
        linksHeight: number
        pageScroll: number
        vw: number
        actionsOffset: number | null
        cardTop: number
        cardBottom: number
        title: string
        hint: string | null
        toggle: string | null
        toggleHeight: number
      }>(`(async () => {
        const card = [...document.querySelectorAll('.ent__item')].find((node) =>
          (node.querySelector('.ent__name')?.textContent || '').startsWith(${JSON.stringify(HUB)}))
        const rows = [...(card ? card.querySelectorAll('[data-entity-link]') : [])]
        const links = card?.querySelector('.ent__links') ?? null
        const actions = card?.querySelector('.ent__actions') ?? null
        const toggle = card?.querySelector('[data-entity-links-toggle]') ?? null
        const first = rows[0]
        return {
          rows: rows.length,
          rowHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
          firstRow: (first?.textContent || '').slice(0, 50),
          cardHeight: card ? Math.round(card.getBoundingClientRect().height) : 0,
          linksHeight: links ? Math.round(links.getBoundingClientRect().height) : 0,
          pageScroll: document.documentElement.scrollWidth,
          vw: window.innerWidth,
          actionsOffset: actions ? Math.round(actions.getBoundingClientRect().top + window.scrollY) : null,
          cardTop: card ? Math.round(card.getBoundingClientRect().top + window.scrollY) : 0,
          cardBottom: card ? Math.round(card.getBoundingClientRect().bottom + window.scrollY) : 0,
          title: (card?.querySelector('.ent__links-title')?.textContent || '').trim(),
          hint: (card?.querySelector('[data-entity-links-hidden]')?.textContent || '').trim() || null,
          toggle: (toggle?.textContent || '').trim() || null,
          toggleHeight: toggle ? Math.round(toggle.getBoundingClientRect().height) : 0,
        }
      })()`)
      console.log(
        `${label}: связей ${data.rows} (строка ${data.rowHeight} px), карточка ${data.cardHeight} px, ` +
          `список ${data.linksHeight} px, страница ${data.pageScroll}/${data.vw}`,
      )
      console.log(
        `   подпись «${data.title}», кнопка «${data.toggle ?? '—'}» ${data.toggleHeight} px, ` +
          `подсказка «${data.hint ?? '—'}»`,
      )
      console.log(`   кнопки карточки начинаются на ${data.actionsOffset} px от верха документа`)
      // Кнопки карточки должны быть не дальше одного экрана от её начала: иначе до правки и
      // связывания надо прокручивать «через стену связей». Проверяется только СВЁРНУТОЕ
      // состояние: раскрывая двадцать связей, человек сам решил прокрутить.
      if (compact && data.actionsOffset !== null) {
        const insideCard = data.actionsOffset - data.cardTop
        if (insideCard > 900) {
          problems.push(`${label}: до кнопок карточки ${insideCard} px внутри неё`)
        }
      }
      // Карточка не должна быть выше трёх экранов: иначе соседние карточки недостижимы.
      const screenBudget = viewportWidth <= 520 ? 3 * 800 : 3 * 900
      if (data.cardHeight > screenBudget) {
        problems.push(`${label}: карточка занимает ${data.cardHeight} px — больше трёх экранов`)
      }
      if (data.pageScroll > data.vw + 1) {
        problems.push(`${label}: горизонтальная прокрутка ${data.pageScroll} > ${data.vw}`)
      }
      return data
    }

    const total = OTHERS.length
    // Карточка с двадцатью связями — та, у которой есть кнопка раскрытия. Ждём её, иначе первый
    // замер успевает пройти до отрисовки списка и показывает ноль (нашёл живой прогон 0.97.3).
    await page.locator('[data-entity-links-toggle]').first().waitFor({ state: 'visible', timeout: 20_000 })
    // 1. Свёрнуто по умолчанию: пять строк, счётчик и кнопка раскрытия.
    const collapsed = await measure(page, '1280 px, свёрнуто', 1280, true)
    if (collapsed.rows !== 5) {
      problems.push(`свёрнутый список показывает ${collapsed.rows} связей вместо 5`)
    }
    if (collapsed.title !== `Связи · ${total}`) {
      problems.push(`подпись списка без числа связей: «${collapsed.title}»`)
    }
    if (collapsed.toggle !== `Показать все ${total}`) {
      problems.push(`кнопка раскрытия подписана «${collapsed.toggle ?? '—'}»`)
    }
    if (collapsed.hint !== `скрыто ещё ${total - 5}`) {
      problems.push(`подсказка о скрытых строках: «${collapsed.hint ?? '—'}»`)
    }
    if (collapsed.toggleHeight < 32) {
      problems.push(`кнопка раскрытия высотой ${collapsed.toggleHeight} px — меньше 32`)
    }
    await page.locator('[data-entity-links]').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '..\\_dev_shots\\entity-links-load-desktop.png' })

    // 2. Раскрыто: все связи на месте, и ничего не пропало.
    await page.locator('[data-entity-links-toggle]').first().click()
    const expanded = await measure(page, '1280 px, раскрыто', 1280, false)
    if (expanded.rows !== total) {
      problems.push(`раскрытый список показывает ${expanded.rows} связей вместо ${total}`)
    }
    if (expanded.toggle !== 'Свернуть связи') {
      problems.push(`кнопка сворачивания подписана «${expanded.toggle ?? '—'}»`)
    }
    if (expanded.hint !== null) {
      problems.push(`в раскрытом списке осталась подсказка «${expanded.hint}»`)
    }
    if (expanded.cardHeight <= collapsed.cardHeight) {
      problems.push('раскрытие не изменило высоту карточки — кнопка ничего не делает')
    }
    await page.screenshot({ path: '..\\_dev_shots\\entity-links-load-expanded.png' })

    // 3. Свернуть обратно: состояние возвращается, а не залипает.
    await page.locator('[data-entity-links-toggle]').first().click()
    const again = await measure(page, '1280 px, снова свёрнуто', 1280, true)
    if (again.rows !== 5) problems.push(`после сворачивания ${again.rows} связей вместо 5`)

    const mobile = await page.context().newPage()
    await mobile.setViewportSize({ width: 360, height: 800 })
    await mobile.goto(`${BASE}/projects/${projectId}`)
    const mobileTab = mobile.locator('[data-project-tab="relations"]')
    await mobileTab.waitFor({ state: 'visible', timeout: 30_000 })
    await mobileTab.click()
    await mobile.locator('[data-entity-link]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await mobile.locator('[data-entity-links-toggle]').first().waitFor({ state: 'visible', timeout: 20_000 })
    const mobileCollapsed = await measure(mobile, '360 px, свёрнуто', 360, true)
    if (mobileCollapsed.toggleHeight < 32) {
      problems.push(`на телефоне кнопка раскрытия ${mobileCollapsed.toggleHeight} px — меньше 32`)
    }
    // Развёрнутый список на телефоне тоже не должен давать горизонтальную прокрутку.
    await mobile.locator('[data-entity-links-toggle]').first().click()
    const mobileExpanded = await measure(mobile, '360 px, раскрыто', 360, false)
    if (mobileExpanded.rows !== total) {
      problems.push(`на телефоне раскрылось ${mobileExpanded.rows} связей вместо ${total}`)
    }
    await mobile.screenshot({ path: '..\\_dev_shots\\entity-links-load-mobile.png' })
    await mobile.close()
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
  console.log('проблемы: нет; снимки: entity-links-load-desktop.png, entity-links-load-mobile.png')
}

await main()
