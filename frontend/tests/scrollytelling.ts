// Проверка сценического таймлайна: кадры глав/под-событий (каждый развёрнут),
// настраиваемый фон, отсутствие связи «клик по стадии → редактор», вместимость текста.
import { chromium, type Page, type BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const OUT = 'C:/Projects/SkyFraze/_scroll_shots'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost'

interface ChildSpec {
  title: string
  body: string
}

interface ChapterSpec {
  title: string
  body: string
  children?: ChildSpec[]
}

const CHAPTERS: ChapterSpec[] = [
  {
    title: 'Запуск «Альфы» — Слепой рывок',
    body: 'Колониальный транспорт «Альфа» отправляется к далёкой звезде. Восемь тысяч человек на борту, три плазменных двигателя на пределе.',
    children: [
      { title: 'Сборка на орбитальной верфи «Прометей-7»', body: 'Восемь тысяч колонистов прошли карантин за шесть месяцев до старта.' },
      { title: 'Старт с орбиты Сатурна', body: '«Альфа» ушла со станции «Сатир-3» в 14:07 по бортовому времени.' },
    ],
  },
  { title: 'Сигналы с Ванкора-7', body: 'Корабль-разведчик «Ванкор» передаёт странные данные из системы Ванкор-7.' },
  { title: 'Теория Гиперсферы', body: 'Астрофизик Йоган Иванов-Шмидт публикует математический аппарат перехода через искривлённое пространство.' },
  { title: 'Восстание ИскИнов на Ганимеде', body: 'Искусственные интеллекты Ганимеда объявляют о самосознании и блокируют коридоры Юпитера.' },
]

interface FrameSnapshot {
  stage: string | null
  chapter: string | null
  frameNumber: string | null
  frameIndex: number
  framesInChapter: number
  frameTitle: string | null
  activeEditor: string | null
  toneVisible: boolean
  copyFits: boolean
  copyIssues: string[]
  /** Вход кадра 0..1: пока он не завершён, лист копирайта на телефоне выезжает снизу. */
  frameEnter: string
  /** Верх листа в текущем (возможно, ещё въезжающем) состоянии. */
  copyTopEntering: number | null
  /** Верх листа в осевшем состоянии. */
  copyTopSettled: number | null
}

async function readFrame(page: Page): Promise<FrameSnapshot> {
  return (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    const copy = document.querySelector('.sf-copy')
    const title = document.querySelector('.sf-copy__title')
    const activeRow = document.querySelector('.ed-row--active')
    const issues = []
    let fits = true
    const check = (el, name) => {
      if (!el) return
      if (el.scrollWidth > el.clientWidth + 1) { fits = false; issues.push(name + ': горизонт ' + el.scrollWidth + '>' + el.clientWidth) }
      const scroller = el.closest('.sf-copy__scroll')
      // Содержимое листа кадра прокручивается внутри него: «ниже сгиба» здесь —
      // нормальное состояние, важно что сам лист целиком в экране, а текст и
      // кнопки навигации доступны. По вертикали проверяем сам лист.
      const target = scroller && scroller !== el ? scroller : el
      const r = target.getBoundingClientRect()
      if (r.left < -1 || r.right > window.innerWidth + 1) { fits = false; issues.push(name + ': вне экрана по X') }
      if (r.top < -1 || r.bottom > window.innerHeight + 1) { fits = false; issues.push(name + ': вне экрана по Y') }
      const own = el.getBoundingClientRect()
      if (own.left < -1 || own.right > window.innerWidth + 1) { fits = false; issues.push(name + ': вне экрана по X (элемент)') }
    }
    // Пока кадр входит, лист копирайта на телефоне выезжает снизу — часть его
    // законно ниже сгиба. Проверяем «осевшее» положение: временно помечаем вход
    // завершённым, снимаем геометрию и возвращаем значение как было.
    const enter = root ? (root.style.getPropertyValue('--sf-frame-enter') || '') : ''
    const copyTopEntering = copy ? Math.round(copy.getBoundingClientRect().top) : null
    if (root) root.style.setProperty('--sf-frame-enter', '1')
    const copyTopSettled = copy ? Math.round(copy.getBoundingClientRect().top) : null
    check(copy, 'copy')
    check(title, 'title')
    check(document.querySelector('.sf-copy__body'), 'body')
    check(document.querySelector('.sf-copy__meta'), 'meta')
    if (root) root.style.setProperty('--sf-frame-enter', enter || '1')
    return {
      stage: root ? root.getAttribute('data-stage') : null,
      chapter: root ? root.getAttribute('data-chapter') : null,
      frameNumber: root ? root.getAttribute('data-frame-number') : null,
      frameIndex: root ? Number(root.getAttribute('data-frame-index')) : -1,
      framesInChapter: root ? Number(root.getAttribute('data-frames-in-chapter')) : -1,
      frameTitle: title ? title.textContent : null,
      activeEditor: activeRow ? (activeRow.textContent || '').trim() : null,
      frameEnter: enter,
      copyTopEntering,
      copyTopSettled,
      toneVisible: !!document.querySelector('.sf-scene[data-active="true"] .sf-scene__tone'),
      copyFits: fits,
      copyIssues: issues,
    }
  })()`)) as FrameSnapshot
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  console.log(`[shot] ${name}.png`)
}

/** Ждём, пока номер кадра перестанет меняться (прыжки и скролл асинхронны). */
async function settleFrame(page: Page, timeoutMs = 4000): Promise<string | null> {
  const started = Date.now()
  let previous: string | null = null
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const current = (await page.evaluate(`(() => {
      const root = document.querySelector('.sf-root')
      return root ? root.getAttribute('data-frame-number') : null
    })()`)) as string | null
    if (current === previous) {
      stable++
      if (stable >= 2) return current
    } else {
      stable = 0
      previous = current
    }
    await page.waitForTimeout(120)
  }
  return previous
}

async function selectRowByText(page: Page, text: string) {
  await page.locator('.ed-row', { hasText: text }).first().click()
  await page.waitForTimeout(300)
}

async function fillEditor(page: Page, title: string, body?: string) {
  await page.locator('.ed-form input[placeholder="Заголовок события"]').fill(title)
  if (body) await page.locator('.ed-form textarea').first().fill(body)
  await page.waitForTimeout(250)
}

async function nextFrame(page: Page): Promise<boolean> {
  const button = page.locator('.sf-copy__nav .sf-btn--primary')
  if (await button.isDisabled().catch(() => true)) return false
  await button.click()
  await settleFrame(page)
  return true
}

async function scrollTop(page: Page): Promise<string | null> {
  await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = 0 })()`)
  return await settleFrame(page)
}

/**
 * Проверка мобильного режима: таймлайн — обычный документ (DocumentTimeline).
 *
 * На узких экранах сцены нет вовсе: кадры идут друг за другом в потоке (текст
 * события, его картинки, текст под-события…), скролл один общий, своей прокрутки
 * у текста нет — иначе палец над текстом крутит поле, а не историю.
 */
async function checkDocumentMode(
  page: Page,
  vp: { width: number; height: number; tag: string },
  expectedFrames: string[],
  errors: string[],
  problems: string[],
): Promise<{ errors: string[]; problems: string[] }> {
  const ok = (label: string, cond: boolean, detail = '') => {
    if (cond) console.log(`  ok   [${vp.tag}] ${label}`)
    else {
      console.log(`  FAIL [${vp.tag}] ${label}${detail ? ' — ' + detail : ''}`)
      problems.push(`[${vp.tag}] ${label}${detail ? ' — ' + detail : ''}`)
    }
  }

  const doc = (await page.evaluate(`(() => {
    const blocks = Array.from(document.querySelectorAll('[data-doc-frame]'))
    const bodies = Array.from(document.querySelectorAll('.sf-doc__event .sf-copy__body'))
    const main = document.querySelector('.layout main')
    return {
      mode: document.querySelector('.sf-root')?.getAttribute('data-stage'),
      kinds: blocks.map((b) => b.getAttribute('data-frame-kind')),
      numbers: blocks.map((b) => b.getAttribute('data-frame-number')),
      hasFixedLayers: !!document.querySelector('.sf-stage, .sf-track, .sf-copylayer'),
      bodiesScroll: bodies.filter((b) => b.scrollHeight > b.clientHeight + 1).length,
      bodiesOverflow: bodies.filter((b) => ['auto', 'scroll'].includes(getComputedStyle(b).overflowY)).length,
      mainScrollable: main ? main.scrollHeight > main.clientHeight + 1 : false,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      editorsButton: !!Array.from(document.querySelectorAll('.sf-doc__actions button, .sf-doc__actions a'))
        .find((el) => /Редактор/i.test(el.textContent || '')),
    }
  })()`)) as Record<string, any>
  console.log(`[${vp.tag}] документ: ${JSON.stringify(doc)}`)

  ok('включён режим документа', doc.mode === 'document', String(doc.mode))
  ok('фиксированных слоёв сцены нет', doc.hasFixedLayers === false)
  ok(
    'у текста нет своей прокрутки',
    Number(doc.bodiesScroll) === 0 && Number(doc.bodiesOverflow) === 0,
    `со своей прокруткой: ${doc.bodiesScroll}, overflow: ${doc.bodiesOverflow}`,
  )
  ok('документ прокручивается целиком', doc.mainScrollable === true)
  ok('нет горизонтального выезда', Number(doc.overflowX) <= 0, String(doc.overflowX))
  ok('кнопка «Редакторы» на месте', doc.editorsButton === true)

  const kinds = doc.kinds as string[]
  const numbers = doc.numbers as string[]
  const eventNumbers = numbers.filter((_, i) => kinds[i] === 'event')
  const head = eventNumbers.slice(0, expectedFrames.length).join(',')
  ok(`кадры-события идут по порядку (${head})`, head === expectedFrames.join(','), head)
  // Картинка идёт после СВОЕГО события: её номер продолжает номер события
  // («01·1» после «01»). У события может быть и несколько картинок подряд.
  const orderOk = (() => {
    let lastEvent = ''
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === 'event') {
        lastEvent = numbers[i]
        continue
      }
      if (!lastEvent || !numbers[i].startsWith(`${lastEvent}·`)) return false
    }
    return kinds.length > 0
  })()
  ok('картинки идут после своего события', orderOk, `${kinds.join(',')} / ${numbers.join(',')}`)

  // Прокрутка: страница едет целиком, полоса событий остаётся на виду.
  await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = m.scrollTop + window.innerHeight })()`)
  await page.waitForTimeout(700)
  const scrolled = (await page.evaluate(`(() => {
    const chips = document.querySelector('.sf-doc__chips')
    const r = chips?.getBoundingClientRect()
    return {
      position: chips ? getComputedStyle(chips).position : null,
      visible: r ? r.top >= -1 && r.bottom <= window.innerHeight : false,
      top: document.querySelector('.layout main')?.scrollTop ?? 0,
    }
  })()`)) as Record<string, any>
  ok('прокрутка сдвинула документ', Number(scrolled.top) > 0, String(scrolled.top))
  ok(
    'переключатель событий липнет и виден',
    scrolled.position === 'sticky' && scrolled.visible === true,
    JSON.stringify(scrolled),
  )
  await shot(page, `${vp.tag}-document`)
  return { errors, problems }
}

async function runViewport(vp: { width: number; height: number; tag: string }) {  const browser = await chromium.launch()
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
    bypassCSP: true,
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const url = m.location()?.url ?? ''
      errors.push(url ? `${m.text()} @ ${url}` : m.text())
    }
  })
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`HTTP ${res.status()} ${res.url()}`)
  })

  await page.goto(`${BASE}/login`)
  await page.fill('input[type="email"]', 'galactic.test@e.com')
  await page.fill('input[type="password"]', 'hunter22!')
  await page.click('button[type="submit"]')
  await page.waitForTimeout(1500)

  const projectName = `Frame Test ${vp.tag} ${Date.now()}`
  await page.goto(`${BASE}/projects`)
  // Ждём саму кнопку, а не фиксированную паузу: под нагрузкой (параллельные тесты
  // на том же стенде) список проектов не успевал отрисоваться за 700 мс.
  await page.waitForSelector('button:has-text("+ Новый проект")', { timeout: 30000 })
  await page.click('button:has-text("+ Новый проект")')
  await page.fill('input[placeholder="Название"]', projectName)
  await page.fill('textarea', 'Проверка кадров стадии.')
  await page.click('button:has-text("Создать")')
  await page.waitForSelector('h3 a')
  await page.locator('h3 a', { hasText: projectName }).first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(1500)

  // Глава 1 из empty-state, остальные — тулбаром редактора
  await page.click('button:has-text("+ Добавить первую главу")')
  await page.waitForTimeout(700)
  await fillEditor(page, CHAPTERS[0].title, CHAPTERS[0].body)
  for (let i = 1; i < CHAPTERS.length; i++) {
    await page.click('.ed-toolbar button:has-text("+ глава")')
    await page.waitForTimeout(450)
    await fillEditor(page, CHAPTERS[i].title, CHAPTERS[i].body)
  }

  // Под-события первой главы: два соседа + внук у первого (событие в событии).
  // Родителя выбираем перед каждым созданием: «+ подсобытие» создаёт ребёнка
  // у ВЫБРАННОГО события.
  const firstChildren = CHAPTERS[0].children ?? []
  const chapterRow = CHAPTERS[0].title.slice(0, 18)
  await selectRowByText(page, chapterRow)
  await page.click('.ed-toolbar button:has-text("+ подсобытие")')
  await page.waitForTimeout(550)
  await fillEditor(page, firstChildren[0].title, firstChildren[0].body)

  // Внук: выбран первый ребёнок — добавляем ему своё под-событие
  await page.click('.ed-toolbar button:has-text("+ подсобытие")')
  await page.waitForTimeout(550)
  await fillEditor(page, 'Под-шаг сборки: испытания корпуса', 'Корпус проверяли на разгерметизацию в вакуумной камере.')

  await selectRowByText(page, chapterRow)
  await page.click('.ed-toolbar button:has-text("+ подсобытие")')
  await page.waitForTimeout(550)
  await fillEditor(page, firstChildren[1].title, firstChildren[1].body)
  await scrollTop(page)

  const expectedFrames = ['01', '01.1', '01.1.1', '01.2']

  // ── на узких экранах таймлайн — документ (DocumentTimeline), а не сцена:
  //    кадры идут друг за другом в потоке, скролл один общий.
  if (vp.width <= 860) {
    return await checkDocumentMode(page, vp, expectedFrames, errors, problems)
  }

  const first = await readFrame(page)
  console.log(`[${vp.tag}] старт: глава=${first.chapter} кадр=${first.frameNumber} кадров в главе=${first.framesInChapter}`)

  // Верхняя панель стадии не должна уезжать под шапку приложения: на телефоне
  // шапка выше, и кнопка «Редакторы» оказывалась под ней (её не видно и не нажать).
  const chrome = (await page.evaluate(`(() => {
    const header = document.querySelector('.layout header')
    const actions = document.querySelector('.sf-topbar__actions')
    const btn = Array.from(document.querySelectorAll('.sf-topbar__actions button, .sf-topbar__actions a'))
      .find((el) => /Редактор/i.test(el.textContent || ''))
    if (!header || !actions) return { ok: false, reason: 'нет шапки или панели стадии' }
    const hb = header.getBoundingClientRect()
    const ab = actions.getBoundingClientRect()
    const varValue = getComputedStyle(document.documentElement).getPropertyValue('--sf-header-h').trim()
    let hit = null
    if (btn) {
      const r = btn.getBoundingClientRect()
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      hit = top ? (btn.contains(top) ? 'button' : (top.className || top.tagName)) : 'none'
    }
    return {
      ok: ab.top >= hb.bottom - 1 && hit === 'button',
      headerBottom: Math.round(hb.bottom),
      actionsTop: Math.round(ab.top),
      varValue,
      hit,
      button: btn ? Math.round(btn.getBoundingClientRect().top) : null,
    }
  })()`)) as { ok: boolean; reason?: string; headerBottom?: number; actionsTop?: number; varValue?: string; hit?: string; button?: number | null }
  console.log(`[${vp.tag}] панель стадии: шапка до ${chrome.headerBottom}px, кнопки с ${chrome.actionsTop}px, --sf-header-h=${chrome.varValue}, клик по «Редакторы» → ${chrome.hit}`)
  if (!chrome.ok) {
    problems.push(
      `панель стадии перекрыта шапкой: шапка до ${chrome.headerBottom}px, кнопки с ${chrome.actionsTop}px, клик → ${chrome.hit}${chrome.reason ? ' (' + chrome.reason + ')' : ''}`,
    )
  }
  if (first.framesInChapter !== expectedFrames.length) {
    problems.push(`кадров в первой главе ${first.framesInChapter}, ожидалось ${expectedFrames.length}`)
  }
  await shot(page, `${vp.tag}-frame-1`)

  // ── проход по кадрам первой главы: каждый под-событие — свой развёрнутый экран
  const editorBefore = first.activeEditor
  const seen: string[] = [first.frameNumber ?? '']
  // На телефоне лист копирайта выезжает снизу, пока кадр входит: убеждаемся, что
  // он действительно поднимается, а не стоит на месте.
  let slideSeen = false
  const noteSlide = (snap: FrameSnapshot) => {
    if (snap.copyTopEntering !== null && snap.copyTopSettled !== null && snap.copyTopEntering > snap.copyTopSettled) {
      slideSeen = true
    }
  }
  noteSlide(first)
  for (let guard = 0; guard < 8; guard++) {
    const snapshot = await readFrame(page)
    noteSlide(snapshot)
    if (!snapshot.copyFits) problems.push(`кадр ${snapshot.frameNumber}: ${snapshot.copyIssues.join('; ')}`)
    if (snapshot.frameIndex > 0) await shot(page, `${vp.tag}-frame-${(snapshot.frameNumber ?? '').replace('.', '_')}`)
    if (!(await nextFrame(page))) break
    const after = await readFrame(page)
    noteSlide(after)
    seen.push(after.frameNumber ?? '')
    if (after.chapter !== first.chapter) break
  }
  if (vp.width <= 860) {
    console.log(`[${vp.tag}] лист кадра выезжает снизу: ${slideSeen}`)
    if (!slideSeen) problems.push('лист кадра не выезжает снизу при входе кадра (на телефоне текст должен раскрываться по мере прокрутки)')
  }
  const expectedNumbers = expectedFrames
  console.log(`[${vp.tag}] кадры первой главы: ${seen.join(' → ')}`)
  if (seen.slice(0, expectedNumbers.length).join(',') !== expectedNumbers.join(',')) {
    problems.push(`последовательность кадров ${seen.join(',')}, ожидалось ${expectedNumbers.join(',')}`)
  }

  const afterWalk = await readFrame(page)
  if (afterWalk.activeEditor !== editorBefore) {
    problems.push(`клик по стадии переключил редактор: "${editorBefore}" → "${afterWalk.activeEditor}"`)
  } else {
    console.log(`[${vp.tag}] редактор стадией не переключается: "${afterWalk.activeEditor}"`)
  }

  // ── настраиваемый фон: ставим тон событию, чей кадр показан, и возвращаемся в кадр.
  //    Клик в редакторе прокручивает страницу к нему (стадия уходит в idle),
  //    поэтому проверяем фон после возврата на трек.
  await scrollTop(page)
  await page.locator('.sf-copy__nav .sf-btn--primary').click() // кадр 01.1
  await settleFrame(page)
  const shown = await readFrame(page)
  const shownTitle = (shown.frameTitle ?? '').slice(0, 16)
  if (shownTitle) await selectRowByText(page, shownTitle)
  await page.click('.ed-bg .ed-chip:has-text("тон")')
  await page.waitForTimeout(350)
  await page.locator('.ed-tone').nth(3).click()
  await page.waitForTimeout(600)

  await scrollTop(page)
  await page.locator('.sf-copy__nav .sf-btn--primary').click() // снова кадр 01.1
  await settleFrame(page)
  const toned = await readFrame(page)
  console.log(`[${vp.tag}] фон-тон виден: ${toned.toneVisible} (кадр ${toned.frameNumber}, "${shownTitle}")`)
  if (!toned.toneVisible) problems.push('настроенный тон фона не отображается в кадре')
  await shot(page, `${vp.tag}-frame-tone`)

  // ── следующая глава
  await scrollTop(page)
  const pill = page.locator('.sf-nav__item').nth(1)
  if (await pill.isVisible().catch(() => false)) await pill.click()
  else await page.locator('.sf-chip').nth(1).click()
  await page.waitForTimeout(1200)
  const second = await readFrame(page)
  console.log(`[${vp.tag}] глава 2: кадр=${second.frameNumber} title="${(second.frameTitle ?? '').slice(0, 26)}" fits=${second.copyFits}`)
  if (!second.copyFits) problems.push(`глава 2: ${second.copyIssues.join('; ')}`)
  await shot(page, `${vp.tag}-chapter-2`)

  // ── маршрут справа: подписи видны постоянно, кегль ≥ 12px, строки не обрезаны
  //    и не мельче 32px, клик по строке переводит на соответствующий кадр.
  if (vp.tag === 'desktop') {
    await scrollTop(page)
    await settleFrame(page)
    const route = (await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.sf-route__row'))
      return rows.map((el) => {
        const label = el.querySelector('.sf-route__label')
        const r = el.getBoundingClientRect()
        return {
          text: (label ? label.textContent : '').trim(),
          size: parseFloat(getComputedStyle(el).fontSize),
          clipped: label ? label.scrollWidth > label.clientWidth + 1 : false,
          h: Math.round(r.height),
        }
      })
    })()`)) as Array<{ text: string; size: number; clipped: boolean; h: number }>
    if (route.length === 0) {
      problems.push('маршрут справа: строки не отрисованы')
    } else {
      const tiny = route.filter((r) => r.size < 12)
      const cut = route.filter((r) => r.clipped)
      const low = route.filter((r) => r.h < 32)
      if (tiny.length) problems.push(`маршрут: мелкий кегль ${tiny[0].size}px у «${tiny[0].text}»`)
      if (cut.length) problems.push(`маршрут: обрезанный текст «${cut[0].text}»`)
      if (low.length) problems.push(`маршрут: высота строки ${low[0].h}px < 32px`)
      console.log(`[${vp.tag}] маршрут: строк ${route.length}, кегль ${route[0].size}px, обрезано ${cut.length}`)
    }

    const row = page.locator('.sf-route__row').nth(2)
    if (await row.isVisible().catch(() => false)) {
      const before = await readFrame(page)
      await row.click()
      await page.waitForTimeout(1200)
      const after = await readFrame(page)
      console.log(`[${vp.tag}] маршрут: клик по строке → кадр ${after.frameNumber}`)
      if (after.frameNumber === before.frameNumber) {
        problems.push(`маршрут: клик по строке не сменил кадр (остался ${before.frameNumber})`)
      }
    } else {
      problems.push('маршрут: строка не кликабельна')
    }
  }

  // ── вложения: загрузка файла → галерея кадра → просмотр в полный размер
  const tmpImage = path.join(OUT, 'upload-sample.png')
  fs.writeFileSync(
    tmpImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoC251gfbC0iCpmkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4NfYAAT8B1WQAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await page.setInputFiles('.ed-upload input[type=file]', tmpImage)
  // Загрузка асинхронная (POST + blob для превью) — ждём появления вложения.
  let attachments = 0
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500)
    attachments = (await page.evaluate(`document.querySelectorAll('.ed-assets__item').length`)) as number
    if (attachments > 0) break
  }
  console.log(`[${vp.tag}] вложений после загрузки: ${attachments}`)
  if (attachments < 1) problems.push('загруженный файл не прикрепился к событию')

  // Вторая картинка у того же события: нужно проверить и листание кадров, и свайп
  // между страницами просмотрщика. Инпут сначала очищаем: повторный выбор того же
  // файла браузер считает «ничем не изменившимся» и событие change не приходит.
  await page.setInputFiles('.ed-upload input[type=file]', [])
  await page.setInputFiles('.ed-upload input[type=file]', tmpImage)
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500)
    attachments = (await page.evaluate(`document.querySelectorAll('.ed-assets__item').length`)) as number
    if (attachments > 1) break
  }
  console.log(`[${vp.tag}] вложений всего: ${attachments}`)
  if (attachments < 2) problems.push(`второй файл не прикрепился (вложений ${attachments})`)

  await scrollTop(page)
  await page.locator('.sf-copy__nav .sf-btn--primary').click() // кадр с вложением
  await settleFrame(page)
  const gallery = (await page.evaluate(`(() => {
    const shots = Array.from(document.querySelectorAll('.sf-copy__shot img'))
    const scene = document.querySelector('.sf-scene[data-active="true"] img.sf-scene__still')
    return {
      shots: shots.length,
      loaded: shots.filter((img) => img.complete && img.naturalWidth > 0).length,
      sceneImage: !!scene,
      sceneLoaded: scene ? (scene.complete && scene.naturalWidth > 0) : false,
    }
  })()`)) as { shots: number; loaded: number; sceneImage: boolean; sceneLoaded: boolean }
  console.log(`[${vp.tag}] галерея кадра: картинок=${gallery.shots} (загружено=${gallery.loaded}), фон-картинка=${gallery.sceneImage} (загружена=${gallery.sceneLoaded})`)
  if (gallery.shots < 2) problems.push(`галерея кадра показывает ${gallery.shots} картинок, ожидалось 2`)
  if (gallery.loaded < 2) problems.push('картинки галереи не загрузились (ассет недоступен)')
  if (gallery.sceneImage && !gallery.sceneLoaded) problems.push('фон-картинка кадра не загрузилась')

  // ── полноэкранный просмотр: отдельный слой поверх сайта, свайп и стрелки
  if (gallery.shots > 0) {
    await page.locator('.sf-copy__shot').first().click()
    await page.waitForSelector('.sf-viewer', { timeout: 5000 }).catch(() => undefined)
    const opened = (await page.evaluate(`!!document.querySelector('.sf-viewer')`)) as boolean
    await shot(page, `${vp.tag}-viewer-1`)
    const viewerState = async () =>
      (await page.evaluate(`(() => {
        const v = document.querySelector('.sf-viewer')
        if (!v) return null
        const img = v.querySelector('.sf-viewer__img')
        const r = v.getBoundingClientRect()
        return {
          index: Number(v.getAttribute('data-viewer-index')),
          total: Number(v.getAttribute('data-viewer-total')),
          counter: (v.querySelector('.sf-viewer__count')?.textContent || '').trim(),
          inViewport: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
          imgLoaded: img ? img.complete && img.naturalWidth > 0 : false,
          topLayer: (() => {
            const cx = Math.round(window.innerWidth / 2)
            const cy = Math.round(window.innerHeight / 2)
            const hit = document.elementFromPoint(cx, cy)
            return !!(hit && hit.closest && hit.closest('.sf-viewer'))
          })(),
          bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
        }
      })()`)) as Record<string, any> | null
    const first = await viewerState()
    console.log(`[${vp.tag}] просмотрщик: ${JSON.stringify(first)}`)
    if (!opened) problems.push('клик по картинке галереи не открывает просмотр')
    if (first) {
      if (first.total !== gallery.shots) problems.push(`просмотрщик показал ${first.total} картинок, в галерее ${gallery.shots}`)
      if (first.index !== 0) problems.push(`просмотрщик открылся на картинке ${first.index}, ожидалось 0`)
      if (!first.topLayer) problems.push('просмотрщик не перекрывает сайт (клик в центре попадает не в него)')
      if (!first.inViewport) problems.push('просмотрщик не помещается на экране')
      if (!first.imgLoaded) problems.push('картинка в просмотрщике не загрузилась')
      if (!first.bodyLocked) problems.push('под открытым просмотрщиком страница продолжает прокручиваться')
    }

    // стрелки: вперёд и назад
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(350)
    const afterKey = await viewerState()
    if (afterKey && afterKey.index !== 1) problems.push(`стрелка → не перелистнула картинку (index=${afterKey.index})`)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(350)
    const afterBack = await viewerState()
    if (afterBack && afterBack.index !== 0) problems.push(`стрелка ← не вернула картинку (index=${afterBack.index})`)

    // свайп: влево — следующая, вправо — предыдущая (на телефоне это жест пальцем).
    // Смещение считаем от ширины экрана: на 320px точка старта +120px попадала на
    // круглую стрелку «›», а жест, начатый на кнопке, свайпом не считается.
    const cx = vp.width / 2
    const cy = vp.height / 2
    const dx = Math.round(vp.width * 0.3)
    const swipe = async (from: number, to: number) => {
      await page.mouse.move(cx + from, cy)
      await page.mouse.down()
      await page.mouse.move(cx + (from + to) / 2, cy, { steps: 8 })
      await page.mouse.move(cx + to, cy, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(350)
      return viewerState()
    }
    const afterSwipeLeft = await swipe(dx, -dx)
    if (afterSwipeLeft && afterSwipeLeft.index !== 1) {
      problems.push(`свайп влево не перелистнул картинку (index=${afterSwipeLeft.index})`)
    }
    const afterSwipeRight = await swipe(-dx, dx)
    console.log(
      `[${vp.tag}] листание просмотрщика: стрелка → ${afterKey?.index}, стрелка ← ${afterBack?.index}, свайп влево ${afterSwipeLeft?.index}, свайп вправо ${afterSwipeRight?.index}`,
    )
    if (afterSwipeRight && afterSwipeRight.index !== 0) {
      problems.push(`свайп вправо не вернул картинку (index=${afterSwipeRight.index})`)
    }
    await shot(page, `${vp.tag}-viewer-2`)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const stillOpen = (await page.evaluate(`!!document.querySelector('.sf-viewer')`)) as boolean
    console.log(`[${vp.tag}] просмотр картинки: открылся=${opened}, закрылся по Esc=${!stillOpen}`)
    if (stillOpen) problems.push('просмотр картинки не закрывается по Esc')
    const scrollRestored = (await page.evaluate(`getComputedStyle(document.body).overflow !== 'hidden'`)) as boolean
    if (!scrollRestored) problems.push('после закрытия просмотра страница осталась заблокированной')
  }

  // ── картинки события идут отдельными кадрами: за кадром события — фотография,
  //    и только потом под-событие. Это и есть «прокрутка показывает картинки
  //    друг за другом до перехода к подсобытию».
  await scrollTop(page)
  await page.locator('.sf-copy__nav .sf-btn--primary').click() // 01.1 — событие с картинками
  await settleFrame(page)
  await page.locator('.sf-copy__nav .sf-btn--primary').click() // 01.1·1 — первый кадр-картинка
  await settleFrame(page)
  const photoFrame = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    const scene = document.querySelector('.sf-scene[data-active="true"] img.sf-scene__still')
    return {
      kind: root ? root.getAttribute('data-frame-kind') : null,
      number: root ? root.getAttribute('data-frame-number') : null,
      photoScene: !!document.querySelector('.sf-scene[data-active="true"] img.sf-scene__still--photo'),
      photoLoaded: scene ? (scene.complete && scene.naturalWidth > 0) : false,
      title: (document.querySelector('.sf-copy--photo .sf-copy__title')?.textContent || '').trim(),
      counter: (document.querySelector('.sf-copy--photo .sf-copy__num')?.textContent || '').trim(),
      framesInChapter: root ? Number(root.getAttribute('data-frames-in-chapter')) : -1,
    }
  })()`)) as Record<string, any>
  console.log(`[${vp.tag}] кадр-картинка: ${JSON.stringify(photoFrame)}`)
  if (photoFrame.kind !== 'image') problems.push(`после кадра события ожидался кадр-картинки, получен ${photoFrame.kind} (${photoFrame.number})`)
  if (!photoFrame.photoScene) problems.push('кадр-картинка не показывает фотографию целиком')
  if (!photoFrame.photoLoaded) problems.push('фотография кадра-картинки не загрузилась')
  if (!/фото 1 \/ 2/.test(String(photoFrame.counter))) problems.push(`подпись кадра-картинки: «${photoFrame.counter}»`)
  if (photoFrame.framesInChapter !== expectedNumbers.length) {
    problems.push(`кадров-событий в главе ${photoFrame.framesInChapter}, ожидалось ${expectedNumbers.length}`)
  }
  await shot(page, `${vp.tag}-photo-frame`)

  // На узких экранах подпись стоит под фотографией: снимок не должен уезжать под
  // панель (там его не видно), а кнопки навигации — быть перекрытыми подсказкой.
  if (vp.width <= 860) {
    const photoLayout = (await page.evaluate(`(() => {
      const img = document.querySelector('.sf-scene[data-active="true"] img.sf-scene__still--photo')
      const copy = document.querySelector('.sf-copy--photo')
      if (!img || !copy) return null
      const cs = getComputedStyle(img)
      const i = img.getBoundingClientRect()
      const c = copy.getBoundingClientRect()
      const contentBottom = i.bottom - parseFloat(cs.paddingBottom)
      const next = document.querySelector('.sf-copy__nav .sf-btn--primary')
      let hit = null
      if (next) {
        const r = next.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        hit = el ? (next.contains(el) ? 'button' : (el.className || el.tagName)) : 'none'
      }
      return {
        overlap: Math.round(contentBottom - c.top),
        photoBottom: Math.round(contentBottom),
        copyTop: Math.round(c.top),
        copies: document.querySelectorAll('.sf-copy').length,
        hit,
        // Снимок и подпись должны целиком укладываться в экран. Верх сцены не
        // проверяем: слой кадра сдвинут параллакс-трансформом и выходит на пиксель.
        photoFits: contentBottom > 0 && contentBottom <= window.innerHeight + 1,
        copyFits: c.top >= -1 && c.bottom <= window.innerHeight + 1,
      }
    })()`)) as Record<string, any> | null
    console.log(`[${vp.tag}] раскладка кадра-картинки: ${JSON.stringify(photoLayout)}`)
    if (!photoLayout) {
      problems.push('кадр-картинка: не найдены фотография или панель подписи')
    } else {
      if (photoLayout.overlap > 0) {
        problems.push(`фотография заходит под панель подписи на ${photoLayout.overlap}px (снимок до ${photoLayout.photoBottom}, панель с ${photoLayout.copyTop})`)
      }
      if (!photoLayout.photoFits) problems.push(`снимок кадра-картинки не помещается на экране (низ ${photoLayout.photoBottom})`)
      if (!photoLayout.copyFits) problems.push('панель подписи кадра-картинки не помещается на экране')
      if (photoLayout.hit !== 'button') problems.push(`кнопка «дальше» на кадре-картинке не нажимается (клик → ${photoLayout.hit})`)
    }
  }

  await page.locator('.sf-copy__nav .sf-btn--primary').click() // 01.1·2 — вторая картинка
  await settleFrame(page)
  const secondPhoto = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    return {
      kind: root ? root.getAttribute('data-frame-kind') : null,
      counter: (document.querySelector('.sf-copy--photo .sf-copy__num')?.textContent || '').trim(),
    }
  })()`)) as Record<string, any>
  if (!/фото 2 \/ 2/.test(String(secondPhoto.counter))) {
    problems.push(`вторая картинка события не показана: «${secondPhoto.counter}»`)
  }

  await page.locator('.sf-copy__nav .sf-btn--primary').click() // 01.1.1 — под-событие
  await settleFrame(page)
  const afterPhotos = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    return {
      kind: root ? root.getAttribute('data-frame-kind') : null,
      number: root ? root.getAttribute('data-frame-number') : null,
      title: (document.querySelector('.sf-copy__title')?.textContent || '').trim(),
    }
  })()`)) as Record<string, any>
  console.log(`[${vp.tag}] после картинок: кадр ${afterPhotos.number} (${afterPhotos.kind}) «${afterPhotos.title}»`)
  if (afterPhotos.kind !== 'event' || afterPhotos.number !== '01.1.1') {
    problems.push(`после картинок ожидался кадр под-события 01.1.1, получен ${afterPhotos.kind} ${afterPhotos.number}`)
  }

  // ── клики по строкам редактора не перехватываются фиксированной стадией
  await page.evaluate(() => {
    document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(700)
  const rowClick = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    const rows = Array.from(document.querySelectorAll('.ed-row'))
    // Берём последнюю строку, которая целиком видна: на 320×568 панель редактора
    // длиннее экрана, и нижняя строка оказывается за пределами вьюпорта —
    // elementFromPoint по ней возвращает null, а это не перехват клика.
    const visible = rows.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0
    })
    const row = visible[visible.length - 1] ?? rows[rows.length - 1]
    if (!row) return { ok: false, checked: false, stage: null, hitClass: null }
    const r = row.getBoundingClientRect()
    const inViewport = r.top >= 0 && r.bottom <= window.innerHeight
    const hit = inViewport ? document.elementFromPoint(r.left + r.width * 0.6, r.top + r.height / 2) : null
    return {
      ok: true,
      checked: inViewport,
      hitClass: hit ? (typeof hit.className === 'string' ? hit.className : hit.tagName) : null,
      inRow: !!(hit && hit.closest && hit.closest('.ed-row')),
      stage: root ? root.getAttribute('data-stage') : null,
    }
  })()`)) as { ok: boolean; checked?: boolean; inRow?: boolean; hitClass?: string | null; stage?: string | null }
  console.log(`[${vp.tag}] клик по строке редактора: проверено=${rowClick.checked}, в строке=${rowClick.inRow} (${rowClick.hitClass}), stage=${rowClick.stage}`)
  if (rowClick.checked && !rowClick.inRow) problems.push(`клик по строке редактора перехватывает «${rowClick.hitClass}»`)

  // ── темы
  const darkBg = await page.evaluate(`getComputedStyle(document.body).backgroundColor`)
  await page.click('button[aria-label="Переключить тему"]')
  await page.waitForTimeout(1200)
  const lightBg = await page.evaluate(`getComputedStyle(document.body).backgroundColor`)
  await shot(page, `${vp.tag}-light`)
  console.log(`[${vp.tag}] тема: ${darkBg} → ${lightBg}`)
  if (darkBg === lightBg) problems.push('тема не переключилась')
  await page.click('button[aria-label="Переключить тему"]')
  await page.waitForTimeout(400)

  // ── редакторы: стадия уходит
  await page.evaluate(() => {
    document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(900)
  const atEditors = await readFrame(page)
  if (atEditors.stage !== 'idle') problems.push(`на редакторах стадия=${atEditors.stage}`)
  await shot(page, `${vp.tag}-editors`)

  console.log(`[${vp.tag}] ошибок консоли: ${errors.length}`)
  for (const e of errors.slice(0, 6)) console.log(`  ! ${e}`)
  await browser.close()
  return { errors, problems }
}

;(async () => {
  const allViewports = [
    { width: 1440, height: 900, tag: 'desktop' },
    { width: 768, height: 1024, tag: 'tablet' },
    { width: 390, height: 844, tag: 'mobile' },
    // 4" экран: здесь подпись кадра-картинки занимает больше строк, и панель
    // налезала на фотографию — проверяем самый тесный случай.
    { width: 320, height: 568, tag: 'mobile-small' },
  ]
  // ONLY_VP=desktop — быстрый прогон одного вьюпорта при отладке
  const filter = process.env.ONLY_VP
  const viewports = filter ? allViewports.filter((v) => v.tag === filter) : allViewports
  let totalErrors = 0
  const allProblems: string[] = []
  for (const vp of viewports) {
    console.log(`\n=== ${vp.tag} ${vp.width}x${vp.height} ===`)
    const r = await runViewport(vp)
    totalErrors += r.errors.length
    for (const p of r.problems) allProblems.push(`[${vp.tag}] ${p}`)
  }
  console.log('\n========== SUMMARY ==========')
  console.log(`Errors: ${totalErrors}`)
  console.log(`Problems: ${allProblems.length}`)
  for (const p of allProblems) console.log(`  ! ${p}`)
})().catch((e) => { console.error('FATAL', e); process.exit(1) })
