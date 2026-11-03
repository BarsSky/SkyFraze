/**
 * Живая проверка знаний проекта (0.149.0).
 *
 * Проверяем путь человека, а не код:
 *  1. в окне три вкладки, и «Знания» открывается;
 *  2. новое знание заводится через форму, появляется в списке с пометкой, размером и автором;
 *  3. знание открывается целиком и удаляется в два нажатия;
 *  4. срок хранения бесед виден и меняется владельцем;
 *  5. на телефоне (390×844) вкладка «Знания» доступна, а окно не вылезает по ширине;
 *     кнопка «Шире» на телефоне скрыта (расширять нечего).
 *
 * Запуск (стенд):
 *   cd frontend
 *   $env:VISUAL_BASE_URL='https://fraze.skynas.ru'; $env:TOKEN=...; $env:REFRESH=...
 *   $env:PROJECT_ID='7fec44b0-…'; npx tsx tests/diag-knowledge.ts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'https://fraze.skynas.ru'
const TOKEN = process.env.TOKEN ?? ''
const REFRESH = process.env.REFRESH ?? ''
const PROJECT_ID = process.env.PROJECT_ID ?? ''
const SHOTS = process.env.SHOTS ?? '..\\_dev_shots'

const findings: Array<{ level: 'error' | 'warning' | 'info'; what: string }> = []
const add = (level: 'error' | 'warning' | 'info', what: string) => findings.push({ level, what })

const TITLE = `Диагностика знаний ${new Date().toISOString().slice(11, 19)}`

async function openDock(page: Page) {
  const openButton = page.getByRole('button', { name: 'Открыть помощника' })
  if (await openButton.count()) await openButton.click()
  await page.locator('[data-assistant-panel]').waitFor({ state: 'visible', timeout: 15_000 })
}

async function openKnowledge(page: Page) {
  await openDock(page)
  await page.locator('[data-dock-tab="knowledge"]').click()
  await page.locator('[data-knowledge-tab]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
}

/** Ширина содержимого против ширины окна: вылезает ли что-то за край. */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const win = document.querySelector('[data-assistant-panel]') as HTMLElement | null
    if (!win) return { win: null, fields: [] as string[] }
    const fields: string[] = []
    for (const node of Array.from(win.querySelectorAll<HTMLElement>('*'))) {
      if (node.scrollWidth > node.clientWidth + 2 && node.clientWidth > 0) {
        const cls = typeof node.className === 'string' ? node.className : ''
        // Прокручиваемые по своей воле списки — не дефект: у них overflow задан явно.
        const style = getComputedStyle(node)
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue
        fields.push(`${node.tagName.toLowerCase()}.${cls.split(' ')[0]} ${node.scrollWidth}>${node.clientWidth}`)
      }
    }
    return {
      win: { width: win.clientWidth, scrollWidth: win.scrollWidth, height: win.clientHeight },
      fields: fields.slice(0, 6),
    }
  })
}

async function desktop() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(
    `localStorage.setItem('skyfraze-auth', ${JSON.stringify(
      JSON.stringify({
        state: { accessToken: TOKEN, refreshToken: REFRESH, user: null, ready: false },
        version: 0,
      }),
    )})`,
  )
  const page = await context.newPage()
  page.on('pageerror', (err) => add('error', `pageerror: ${err.message}`))
  await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  await openDock(page)
  const tabs = await page.locator('[data-dock-tab]').count()
  add(tabs === 3 ? 'info' : 'error', `вкладок в окне: ${tabs} (ожидалось 3)`)

  await openKnowledge(page)
  // Создаём знание через форму — так же, как это сделал бы человек.
  await page.locator('[data-knowledge-create]').click()
  await page.locator('[data-knowledge-title]').fill(TITLE)
  await page.locator('[data-knowledge-summary]').fill('пометка из живой проверки')
  await page.locator('[data-knowledge-body]').fill(
    'Тезис 1. Тезис 2. Это знание создано живой проверкой и будет удалено в конце.',
  )
  // Метки (0.152.0): по ним поиск должен находить знание, даже если слова нет в тексте.
  await page.locator('[data-knowledge-tags]').fill('диагностика, теги')
  await page.locator('[data-knowledge-save]').click()
  await page.waitForTimeout(2000)
  const state = await page.evaluate(() => ({
    error: (document.querySelector('[data-knowledge-error]')?.textContent ?? '').trim(),
    items: document.querySelectorAll('[data-knowledge-item]').length,
    empty: (document.querySelector('[data-knowledge-empty]')?.textContent ?? '').trim().slice(0, 80),
    formOpen: document.querySelector('[data-knowledge-form]') !== null,
    list: (document.querySelector('[data-knowledge-list]')?.textContent ?? '').slice(0, 160),
  }))
  add('info', `после сохранения: ${JSON.stringify(state)}`)
  await page.screenshot({ path: `${SHOTS}\\knowledge-after-save.png` })

  const listText = state.list
  if (!listText.includes(TITLE)) add('error', `новое знание не появилось в списке: ${listText.slice(0, 120)}`)
  else add('info', 'знание создано и видно в списке')
  const item = page.locator(`[data-knowledge-item]`, { hasText: TITLE }).first()
  const meta = (await item.innerText()) ?? ''
  if (!/\d/.test(meta)) add('warning', `в карточке знания нет размера/даты: ${meta.slice(0, 120)}`)
  const tagsShown = await item.locator('[data-knowledge-item-tags]').count()
  if (tagsShown === 0) add('error', 'метки знания не показаны в списке')
  else add('info', 'метки показаны в списке')

  // Поиск по метке: в тексте знания слова «теги» нет, найтись оно должно по метке.
  const search = page.locator('[data-knowledge-search]')
  await search.fill('теги')
  await page.waitForTimeout(900)
  const foundByTag = ((await page.locator('[data-knowledge-tab]').innerText()) ?? '').includes(TITLE)
  add(foundByTag ? 'info' : 'error', `поиск по метке «теги»: ${foundByTag ? 'нашёл' : 'не нашёл'}`)
  // Морфология (0.153.0): словарь «russian» находит словоформу, которой в тексте нет.
  await search.fill('тезисами')
  await page.waitForTimeout(900)
  const foundByStem = ((await page.locator('[data-knowledge-tab]').innerText()) ?? '').includes(TITLE)
  add(foundByStem ? 'info' : 'error', `поиск словоформы «тезисами»: ${foundByStem ? 'нашёл' : 'не нашёл'}`)
  await search.fill('')
  await page.waitForTimeout(700)

  // Подсказка меток (0.153.0): после первого знания форма должна предлагать его метки.
  await page.locator('[data-knowledge-create]').click()
  await page.waitForTimeout(900)
  const tagOptions = await page.locator('[data-knowledge-tag-options] option').count()
  add(tagOptions > 0 ? 'info' : 'warning', `подсказка меток: ${tagOptions} вариантов`)
  await page.locator('[data-knowledge-form] button', { hasText: 'Отмена' }).first().click()
  await page.waitForTimeout(300)

  // Открытие целиком: тело приходит отдельным запросом.
  await item.locator('.knowledge__open').click()
  await page.locator('[data-knowledge-view]').waitFor({ state: 'visible', timeout: 10_000 })
  const body = (await page.locator('[data-knowledge-view]').innerText()) ?? ''
  if (!body.includes('Тезис 1')) add('error', `тело знания не открылось: ${body.slice(0, 120)}`)
  const viewTags = await page.locator('[data-knowledge-view-tags]').count()
  add(viewTags > 0 ? 'info' : 'error', `метки в открытом знании: ${viewTags > 0 ? 'есть' : 'нет'}`)
  await page.screenshot({ path: `${SHOTS}\\knowledge-desktop.png` })
  await page.locator('[data-knowledge-view] button', { hasText: 'Закрыть' }).first().click()
  await page.waitForTimeout(400)

  // Срок хранения: виден и (для владельца) доступен.
  const retention = page.locator('[data-knowledge-retention]')
  if ((await retention.count()) === 0) add('error', 'нет выбора срока хранения бесед')
  else if (await retention.isDisabled()) add('warning', 'срок хранения недоступен (пользователь не владелец?)')
  else add('info', 'срок хранения доступен владельцу')
  // Предупреждение автоочистки (0.150.0): при сроке 0 его нет, при сроке > 0 — есть.
  const warningBox = page.locator('[data-knowledge-retention-warning]')
  const warning =
    (await warningBox.count()) > 0 ? ((await warningBox.innerText()) ?? '').trim() : ''
  add('info', `предупреждение автоочистки: ${warning || 'скрыто (срок 0)'}`)

  // Булавка «не удалять эту беседу» (0.150.0): в «Истории» помощника. Два нажатия —
  // помечаем и снимаем, чтобы не менять проект.
  await page.locator('[data-dock-tab="assistant"]').click()
  // Список бесед приходит с сервера, кнопка «История» появляется не сразу.
  await page.waitForTimeout(1800)
  const historyButton = page.locator('[data-assistant-history-button]')
  if ((await historyButton.count()) === 0) {
    add('warning', 'нет истории бесед: булавку не проверить')
  } else {
    await historyButton.click()
    const pin = page.locator('[data-assistant-keep-conversation]').first()
    if ((await pin.count()) === 0) {
      add('error', 'в истории нет кнопки «не удалять эту беседу»')
    } else {
      const before = await pin.getAttribute('aria-pressed')
      await pin.click()
      await page.waitForTimeout(700)
      const after = await pin.getAttribute('aria-pressed')
      await pin.click()
      await page.waitForTimeout(700)
      add(
        before !== after && before === 'false' && after === 'true' ? 'info' : 'warning',
        `булавка «не удалять»: ${before} → ${after}`,
      )
    }
  }
  // Возвращаемся на вкладку знаний в любом случае: удаление проверяем там.
  await page.locator('[data-dock-tab="knowledge"]').click()
  await page.locator('[data-knowledge-tab]').waitFor({ state: 'visible', timeout: 5_000 })

  // Удаление: первое нажатие только спрашивает, второе удаляет.
  const deleteButton = item.locator('[data-knowledge-delete]')
  await deleteButton.click()
  await page.waitForTimeout(600)
  const armed = (await deleteButton.innerText()) ?? ''
  if (!armed.includes('Точно удалить?')) add('warning', `первое нажатие не спрашивает: ${armed}`)
  const afterFirst = (await page.locator('[data-knowledge-tab]').innerText()) ?? ''
  if (!afterFirst.includes(TITLE)) add('error', 'знание удалилось с первого нажатия (не должно)')
  await deleteButton.click()
  await page.waitForTimeout(1200)
  // Список после последнего удаления исчезает вместе с элементом — читаем вкладку целиком.
  const afterSecond = (await page.locator('[data-knowledge-tab]').innerText()) ?? ''
  if (afterSecond.includes(TITLE)) add('error', 'знание не удалилось со второго нажатия')
  else add('info', 'знание удалено в два нажатия')

  const over = await overflow(page)
  if (over.fields.length > 0) add('warning', `вылезает за край окна: ${over.fields.join('; ')}`)
  if (over.win && over.win.scrollWidth > over.win.width + 2) {
    add('warning', `окно шире себя: ${over.win.scrollWidth} > ${over.win.width}`)
  }
  await browser.close()
}

async function phone() {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  await context.addInitScript(
    `localStorage.setItem('skyfraze-auth', ${JSON.stringify(
      JSON.stringify({
        state: { accessToken: TOKEN, refreshToken: REFRESH, user: null, ready: false },
        version: 0,
      }),
    )})`,
  )
  const page = await context.newPage()
  page.on('pageerror', (err) => add('error', `pageerror(phone): ${err.message}`))
  await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  await openKnowledge(page)
  const tab = page.locator('[data-dock-tab="knowledge"]')
  const box = await tab.boundingBox()
  if (!box || box.height < 28) add('warning', `вкладка знаний на телефоне мелкая: ${JSON.stringify(box)}`)
  const wideVisible = await page.locator('[data-dock-wide]').isVisible()
  if (wideVisible) add('warning', 'кнопка «Шире» видна на телефоне — расширять нечего')
  const over = await overflow(page)
  if (over.fields.length > 0) add('warning', `телефон: вылезает за край: ${over.fields.join('; ')}`)
  if (over.win) {
    if (over.win.width > 390) add('error', `телефон: окно шире экрана (${over.win.width})`)
    if (over.win.height > 844) add('error', `телефон: окно выше экрана (${over.win.height})`)
  }
  await page.screenshot({ path: `${SHOTS}\\knowledge-phone.png` })
  await browser.close()
}

async function main() {
  if (!TOKEN || !REFRESH || !PROJECT_ID) {
    console.error('нужны TOKEN, REFRESH и PROJECT_ID')
    process.exit(1)
  }
  try {
    await desktop()
    await phone()
  } catch (e) {
    // Сценарий упал на шаге — это тоже находка: печатаем то, что уже успели увидеть.
    add('error', `сценарий упал: ${(e as Error).message.split('\n')[0]}`)
  }
  // Убираем диагностические знания, даже если сценарий сорвался посередине: в чужом
  // демо-проекте не должно оставаться мусора от проверки.
  await cleanupDiagnostics()

  const errors = findings.filter((item) => item.level === 'error')
  for (const item of findings) console.log(`${item.level.toUpperCase()}: ${item.what}`)
  console.log(`\nошибок: ${errors.length}, предупреждений: ${findings.filter((f) => f.level === 'warning').length}`)
  process.exit(errors.length > 0 ? 1 : 0)
}

/** Удалить знания, созданные прошлыми прогонами проверки (по префиксу заголовка). */
async function cleanupDiagnostics() {
  try {
    const headers = { authorization: `Bearer ${TOKEN}` }
    const response = await fetch(`${BASE}/api/projects/${PROJECT_ID}/ai/knowledge`, { headers })
    if (!response.ok) return
    const payload = (await response.json()) as { knowledge?: Array<{ id: string; title: string }> }
    for (const item of payload.knowledge ?? []) {
      if (!item.title.startsWith('Диагностика знаний')) continue
      await fetch(`${BASE}/api/projects/${PROJECT_ID}/ai/knowledge/${item.id}`, {
        method: 'DELETE',
        headers,
      })
    }
  } catch {
    // Уборка — не часть проверки: если сеть недоступна, об этом уже сказал сценарий.
  }
}

void main()
