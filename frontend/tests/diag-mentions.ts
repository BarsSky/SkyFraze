/**
 * Живая проверка «Упоминаний в кадре» (0.92.1).
 *
 * Отчёт человека: «упоминания дублируются слишком много раз… при большем количестве будет расти
 * список и вылезать из-за чего можно будет потеряться». Проверяем ровно это, числами:
 *   * сколько вхождений в кадре и сколько чипов (должен быть один чип на КАРТОЧКУ);
 *   * счётчик вхождений и перебор вхождений по нажатию (каждое место в тексте достижимо);
 *   * длинный список сворачивается в «ещё N» и раскрывается;
 *   * список не шире панели и страница не получает горизонтальной прокрутки на 360 px;
 *   * цель нажатия на телефоне не меньше 32 px.
 *
 * Свой проект создаётся и удаляется скриптом, поэтому стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-mentions.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const OUT = '..\\_dev_shots\\mentions-360.png'

/** Карточек больше лимита чипов — чтобы «ещё N» тоже было проверено. */
const ENTITIES = [
  'Юпитер', 'Ио', 'Европа', 'Ганимед', 'Каллисто', 'Амальтея', 'Гималия', 'Элара', 'Пасифе',
]

/** Текст кадра: Ганимед назван шесть раз, Юпитер и Ио — по два, остальные по одному. */
const BODY = [
  'Юпитер и Ио были рядом. Европа и Ганимед спорили. Ганимед снова.',
  '',
  'Юпитер молчал. Ио ждала. Европа ушла. Ганимед вернулся. Каллисто спал.',
  'Амальтея пела, Гималия слушала, Элара молчала, Пасифе считал.',
  '',
  'Ганимед, Ганимед и ещё раз Ганимед.',
].join('\n')

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
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

  const projectResponse = await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика упоминаний', description: '' },
  })
  const projectBody = (await projectResponse.json()) as { project?: { id: string }; id?: string }
  const projectId = projectBody.project?.id ?? projectBody.id ?? ''
  if (!projectId) {
    console.log('не удалось создать проект:', projectResponse.status(), projectBody)
    process.exitCode = 1
    return
  }
  console.log(`проект: ${projectId}`)

  try {
    for (const name of ENTITIES) {
      const response = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
        headers,
        data: { name, kind: 'place' },
      })
      if (response.status() !== 201) problems.push(`карточка «${name}»: ${response.status()}`)
    }
    // Кадр создаём ЧЕРЕЗ ИНТЕРФЕЙС, а не запросом проекции: текст кадра живёт в CRDT, и кадр,
    // созданный одним API, в браузере не появится (CRDT — источник правды, проекция — производная).
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    const editorsTab = page.locator('[data-project-tab="editors"]')
    await editorsTab.waitFor({ state: 'visible', timeout: 30_000 })
    await editorsTab.click()
    const rows = page.locator('.ed-row')
    await rows.first().waitFor({ timeout: 20_000 })
    await rows.first().click()
    await page.getByPlaceholder('Заголовок события').fill('Глава')
    const bodyArea = page.locator('.ed-editor textarea').first()
    await bodyArea.waitFor({ state: 'visible', timeout: 20_000 })
    await bodyArea.fill(BODY)
    // Ждём, пока правка доедет до сервера: иначе следующий шаг проверит старый текст.
    const started = Date.now()
    let projected = false
    while (Date.now() - started < 40_000) {
      const response = await page.request.get(`${API}/api/projects/${projectId}/export.md`, { headers })
      const text = (await response.body()).toString('utf8')
      if (text.includes('Ганимед')) {
        projected = true
        break
      }
      await page.waitForTimeout(1000)
    }
    if (!projected) problems.push('текст кадра не доехал до сервера за 40 с')
    else console.log(`текст спроецирован за ${Date.now() - started} мс`)

    await page.locator('[data-frame-mentions]').waitFor({ timeout: 20_000 })
    await page.locator('[data-frame-mentions]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    // 1. Один чип на карточку, счётчики — сколько раз названа.
    const chips = await page.evaluate<Array<{ id: string; count: number; text: string; height: number }>>(`(async () => {
      const nodes = [...document.querySelectorAll('[data-frame-mention]')]
      return nodes.map((node) => ({
        id: node.getAttribute('data-frame-mention'),
        count: Number(node.getAttribute('data-frame-mention-count') || '0'),
        text: node.textContent || '',
        height: Math.round(node.getBoundingClientRect().height),
      }))
    })()`)
    const ids = chips.map((chip) => chip.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    if (duplicates.length > 0) problems.push(`чипы дублируются: ${duplicates.join(', ')}`)
    const totalMentions = chips.reduce((sum, chip) => sum + chip.count, 0)
    console.log(`чипов: ${chips.length}, вхождений на видимых: ${totalMentions}`)
    for (const chip of chips) console.log(`   ${chip.text} (${chip.count})`)
    if (chips.length > 6) problems.push(`видимых чипов ${chips.length}, лимит 6 не сработал`)
    const smallTargets = chips.filter((chip) => chip.height < 32)
    if (smallTargets.length > 0) problems.push(`мелкие цели нажатия: ${smallTargets.map((chip) => chip.text).join(', ')}`)

    // 2. Геометрия: список не шире панели, страница без горизонтальной прокрутки.
    const geometry = await page.evaluate<{
      vw: number
      scrollWidth: number
      panelWidth: number | null
      panelScrollWidth: number | null
      mentionsWidth: number | null
      wider: string[]
    }>(`(async () => {
      const vw = window.innerWidth
      const panel = document.querySelector('#project-tab-panel')
      const mentions = document.querySelector('[data-frame-mentions]')
      const out = []
      for (const el of document.querySelectorAll('#project-tab-panel *')) {
        const box = el.getBoundingClientRect()
        if (box.width > 0 && box.right > vw + 0.5) {
          out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.') + ' right=' + Math.round(box.right))
          if (out.length > 10) break
        }
      }
      return {
        vw,
        scrollWidth: document.documentElement.scrollWidth,
        panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
        panelScrollWidth: panel ? panel.scrollWidth : null,
        mentionsWidth: mentions ? Math.round(mentions.getBoundingClientRect().width) : null,
        wider: out,
      }
    })()`)
    console.log(`360 px: панель ${geometry.panelWidth}/${geometry.panelScrollWidth}, упоминания ${geometry.mentionsWidth}, страница ${geometry.scrollWidth}/${geometry.vw}`)
    if (geometry.scrollWidth > geometry.vw + 1) {
      problems.push(`горизонтальная прокрутка страницы: ${geometry.scrollWidth} > ${geometry.vw}`)
    }
    if (geometry.panelScrollWidth && geometry.panelWidth && geometry.panelScrollWidth > geometry.panelWidth + 1) {
      problems.push(`панель шире себя: ${geometry.panelScrollWidth} > ${geometry.panelWidth}`)
    }
    for (const item of geometry.wider) problems.push(`за краем: ${item}`)

    // 3. «ещё N» раскрывает остальные карточки и сворачивает обратно.
    const more = page.getByRole('button', { name: /ещё \d+/ })
    if ((await more.count()) === 0) {
      problems.push('нет кнопки «ещё N» при девяти карточках')
    } else {
      const label = await more.innerText()
      await more.click()
      const all = await page.evaluate<{ count: number; mentions: number }>(`(async () => {
        const nodes = [...document.querySelectorAll('[data-frame-mention]')]
        return {
          count: nodes.length,
          mentions: nodes.reduce((sum, node) => sum + Number(node.getAttribute('data-frame-mention-count') || '0'), 0),
        }
      })()`)
      console.log(`«${label.trim()}» → чипов: ${all.count}, вхождений всего: ${all.mentions}`)
      if (all.count !== ENTITIES.length) problems.push(`после раскрытия чипов ${all.count}, ожидалось ${ENTITIES.length}`)
      // Вхождений в кадре 17 (Ганимед 6, Юпитер/Ио/Европа по 2, остальные по 1): если счётчики
      // теряют вхождения, это видно здесь, а не через месяц в отчёте о пропавшем упоминании.
      if (all.mentions !== 17) problems.push(`вхождений всего ${all.mentions}, ожидалось 17`)
      await page.getByRole('button', { name: 'свернуть' }).click()
      const collapsed = await page.locator('[data-frame-mention]').count()
      if (collapsed !== 6) problems.push(`после сворачивания чипов ${collapsed}, ожидалось 6`)
    }

    // 4. Перебор вхождений: три нажатия по «Ганимеду» ведут в три разных места текста.
    const ganymede = page.locator('[data-frame-mention]', { hasText: 'Ганимед' }).first()
    const positions: number[] = []
    for (let press = 0; press < 3; press += 1) {
      await ganymede.click()
      await page.waitForTimeout(200)
      const selection = await page.evaluate<{ start: number; end: number; focused: boolean }>(`(async () => {
        const area = document.querySelector('.ed-editor textarea')
        if (!area) return { start: -1, end: -1, focused: false }
        return { start: area.selectionStart, end: area.selectionEnd, focused: document.activeElement === area }
      })()`)
      positions.push(selection.start)
      console.log(`нажатие ${press + 1}: выделение ${selection.start}..${selection.end}`)
    }
    const distinct = new Set(positions.filter((value) => value >= 0))
    if (distinct.size < 3) problems.push(`перебор вхождений стоит на месте: ${positions.join(', ')}`)

    await page.screenshot({ path: OUT })
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
  console.log(`проблемы: нет; снимок: ${OUT}`)
}

await main()
