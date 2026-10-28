/**
 * Живая проверка списка связей в «Связях проекта» (0.97.2).
 *
 * Отчёт: «связи проекта сливаются при перечислении в блоке, и если текста больше — расползается
 * ряд». Проверяем числами: у каждой связи своя строка с видимым зазором, строки не вылезают за
 * панель (длинное имя переносится внутри), и подпись блока «Связи» на месте.
 *
 * Проект, карточки и связи создаются и удаляются скриптом — стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-entity-links.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

/** Длинное имя — проверка переноса: строка не должна расползаться шире панели. */
const CARDS = ['Аня', 'Земля', 'Сторож маяка на северном берегу', 'Письмо из-за пролива']
const LINKS: Array<[string, string, string]> = [
  ['Аня', 'Земля', 'живёт на'],
  ['Аня', 'Сторож маяка на северном берегу', 'боится'],
  ['Аня', 'Письмо из-за пролива', 'нашла письмо от'],
  ['Земля', 'Сторож маяка на северном берегу', 'принадлежит'],
  ['Земля', 'Письмо из-за пролива', 'упоминается в'],
]

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
    data: { title: 'Диагностика связей', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id
  console.log(`проект: ${projectId}`)

  try {
    // Вкладки проекта появляются только когда в проекте есть содержимое: заводим главу через
    // интерфейс (текст живёт в CRDT), иначе вкладки «Связи» на странице не будет вовсе.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })

    const ids = new Map<string, string>()
    for (const name of CARDS) {
      const response = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
        headers,
        data: { name, kind: name === 'Земля' ? 'place' : 'character' },
      })
      if (response.status() !== 201) problems.push(`карточка «${name}»: ${response.status()}`)
      const body = (await response.json()) as { entity?: { id: string } }
      if (body.entity?.id) ids.set(name, body.entity.id)
    }
    for (const [from, to, label] of LINKS) {
      const response = await page.request.post(`${API}/api/projects/${projectId}/entities/${ids.get(from)}/links`, {
        headers,
        data: { to: ids.get(to), label },
      })
      if (response.status() !== 201) problems.push(`связь «${from} ${label} ${to}»: ${response.status()}`)
    }

    // «Связи» — вкладка проекта; блок карточек раскрыт по умолчанию (matrixOpen).
    await page.reload()
    await page.goto(`${BASE}/projects/${projectId}`)
    const relationsTab = page.locator('[data-project-tab="relations"]')
    await relationsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await relationsTab.click()
    // Блок карточек — раскрывающийся (`details`): его состояние помнится в localStorage, и у
    // человека он может быть свёрнут. Раскрываем, если закрыт: связи живут внутри.
    const entityPanel = page.locator('details.ent')
    await entityPanel.waitFor({ state: 'attached', timeout: 20_000 })
    if (!(await entityPanel.evaluate((node: HTMLDetailsElement) => node.open))) {
      await entityPanel.locator('summary').first().click()
    }
    const links = page.locator('[data-entity-link]')
    await links.first().waitFor({ state: 'visible', timeout: 20_000 })
    const count = await links.count()
    console.log(`строк связей: ${count}`)

    // 1. Подпись блока и границы строк.
    const titles = await page.locator('.ent__links-title').allInnerTexts()
    // text-transform: uppercase — innerText вернёт «СВЯЗИ», сравниваем без регистра.
    if (!titles.some((text) => text.trim().toLowerCase().startsWith('связи'))) {
      problems.push(`нет подписи «Связи» у списка: ${JSON.stringify(titles)}`)
    }

    const geometry = await page.evaluate<{ vw: number; panelRight: number | null; pageScroll: number; rows: Array<{ top: number; bottom: number; height: number; right: number; width: number; overflowX: boolean; text: string }> }>(`(async () => {
      const panel = document.querySelector('#project-tab-panel')
      const rows = [...document.querySelectorAll('[data-entity-link]')].map((node) => {
        const box = node.getBoundingClientRect()
        return {
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          height: Math.round(box.height),
          right: Math.round(box.right),
          width: Math.round(box.width),
          overflowX: node.scrollWidth > node.clientWidth + 1,
          text: (node.textContent || '').slice(0, 40),
        }
      })
      return {
        vw: window.innerWidth,
        panelRight: panel ? Math.round(panel.getBoundingClientRect().right) : null,
        pageScroll: document.documentElement.scrollWidth,
        rows,
      }
    })()`)
    console.log(`строк: ${geometry.rows.length}, страница ${geometry.pageScroll}/${geometry.vw}`)
    if (geometry.pageScroll > geometry.vw + 1) {
      problems.push(`горизонтальная прокрутка страницы: ${geometry.pageScroll} > ${geometry.vw}`)
    }
    for (const row of geometry.rows) {
      if (geometry.panelRight !== null && row.right > geometry.panelRight + 1) {
        problems.push(`строка связи вылезает за панель: ${row.text}`)
      }
      if (row.overflowX) problems.push(`связь не переносится: ${row.text}`)
      if (row.height < 26) problems.push(`строка связи слишком низкая: ${row.text}`)
    }
    // 2. Строки не слипаются: у соседних строк из разных карточек есть зазор.
    const tops = geometry.rows.map((row) => row.bottom).sort((a, b) => a - b)
    const bottoms = geometry.rows.map((row) => row.top).sort((a, b) => a - b)
    let gaps = 0
    for (const bottom of tops) {
      const next = bottoms.find((top) => top > bottom)
      if (next !== undefined && next - bottom >= 4) gaps += 1
    }
    console.log(`зазоров между строками: ${gaps}`)
    if (gaps === 0 && geometry.rows.length > 1) problems.push('строки связей слипаются: зазора нет')

    // Снимок — с блоком связей в кадре: граф выше, и без прокрутки список не видно.
    await page.locator('[data-entity-links]').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '..\\_dev_shots\\entity-links-desktop.png' })

    // 3. Карточки разложены по видам (0.97.7): «Персонажи · 3» и «Места · 1», каждая группа
    // сворачивается, и свёрнутая не оставляет за собой пустых строк.
    const groupData = await page.evaluate<{
      groups: Array<{ kind: string; title: string; open: boolean; items: number }>
    }>(`(async () => {
      const groups = [...document.querySelectorAll('[data-entity-group]')].map((node) => ({
        kind: node.getAttribute('data-entity-group') || '',
        title: (node.querySelector('.ent__group-summary')?.textContent || '').trim(),
        open: node.open === true,
        items: node.querySelectorAll('[data-entity-kind]').length,
      }))
      return { groups }
    })()`)
    for (const group of groupData.groups) {
      console.log(`группа «${group.title}»: карточек ${group.items}, раскрыта ${group.open}`)
    }
    const byKind = new Map(groupData.groups.map((group) => [group.kind, group]))
    if (groupData.groups.length !== 2) {
      problems.push(`ожидалось две группы (персонажи и места), а их ${groupData.groups.length}`)
    }
    if (byKind.get('character')?.items !== 3) {
      problems.push(`в группе персонажей ${byKind.get('character')?.items ?? 0} карточек вместо 3`)
    }
    if (byKind.get('place')?.items !== 1) {
      problems.push(`в группе мест ${byKind.get('place')?.items ?? 0} карточек вместо 1`)
    }
    if (!byKind.get('character')?.title.includes('3')) {
      problems.push(`в подписи группы нет числа карточек: «${byKind.get('character')?.title ?? ''}»`)
    }

    const characters = page.locator('[data-entity-group="character"]')
    const expandedHeight = (await characters.evaluate(
      `(async (node) => Math.round(node.getBoundingClientRect().height))(document.querySelector('[data-entity-group="character"]'))`,
    )) as number
    await characters.locator('summary').first().click()
    await page.waitForTimeout(200)
    // Меряем высоту группы, а не «видимость» карточек: в свежем Chromium закрытый `details`
    // прячет содержимое через content-visibility, и getBoundingClientRect у него не нулевой.
    // Высота группы — то, что видит человек: одна строка подписи вместо трёх карточек.
    const collapsed = (await characters.evaluate(
      `(async (node) => ({ open: node.open === true, height: Math.round(node.getBoundingClientRect().height) }))(document.querySelector('[data-entity-group="character"]'))`,
    )) as { open: boolean; height: number }
    console.log(
      `группа персонажей: было ${expandedHeight} px, свёрнуто ${collapsed.height} px (open ${collapsed.open})`,
    )
    if (collapsed.open) problems.push('группа не свернулась по нажатию на подпись')
    if (collapsed.height > 120 || collapsed.height * 2 > expandedHeight) {
      problems.push(`свёрнутая группа занимает ${collapsed.height} px — карточки остались на месте`)
    }
    await page.locator('[data-entity-links]').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '..\\_dev_shots\\entity-groups-collapsed.png' })
    await characters.locator('summary').first().click()

    // 3. Телефон: тот же список не вылезает за экран.
    const mobile = await page.context().newPage()
    await mobile.setViewportSize({ width: 360, height: 800 })
    await mobile.goto(`${BASE}/projects/${projectId}`)
    const mobileTab = mobile.locator('[data-project-tab="relations"]')
    await mobileTab.waitFor({ state: 'visible', timeout: 30_000 })
    await mobileTab.click()
    await mobile.locator('[data-entity-link]').first().waitFor({ state: 'visible', timeout: 20_000 })
    const mobileScroll = await mobile.evaluate<number>(`(async () => document.documentElement.scrollWidth)()`)
    console.log(`телефон 360 px: ширина страницы ${mobileScroll}`)
    if (mobileScroll > 361) problems.push(`на телефоне горизонтальная прокрутка: ${mobileScroll}`)
    await mobile.locator('[data-entity-links]').first().scrollIntoViewIfNeeded()
    await mobile.screenshot({ path: '..\\_dev_shots\\entity-links-mobile.png' })
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
  console.log('проблемы: нет; снимки: entity-links-desktop.png, entity-links-mobile.png')
}

await main()
