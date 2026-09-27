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
      const r = el.getBoundingClientRect()
      if (r.left < -1 || r.right > window.innerWidth + 1) { fits = false; issues.push(name + ': вне экрана по X') }
      if (r.top < -1 || r.bottom > window.innerHeight + 1) { fits = false; issues.push(name + ': вне экрана по Y') }
    }
    check(copy, 'copy')
    check(title, 'title')
    check(document.querySelector('.sf-copy__body'), 'body')
    check(document.querySelector('.sf-copy__meta'), 'meta')
    return {
      stage: root ? root.getAttribute('data-stage') : null,
      chapter: root ? root.getAttribute('data-chapter') : null,
      frameNumber: root ? root.getAttribute('data-frame-number') : null,
      frameIndex: root ? Number(root.getAttribute('data-frame-index')) : -1,
      framesInChapter: root ? Number(root.getAttribute('data-frames-in-chapter')) : -1,
      frameTitle: title ? title.textContent : null,
      activeEditor: activeRow ? (activeRow.textContent || '').trim() : null,
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

async function runViewport(vp: { width: number; height: number; tag: string }) {
  const browser = await chromium.launch()
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
  await page.waitForTimeout(700)
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
  for (let guard = 0; guard < 8; guard++) {
    const snapshot = await readFrame(page)
    if (!snapshot.copyFits) problems.push(`кадр ${snapshot.frameNumber}: ${snapshot.copyIssues.join('; ')}`)
    if (snapshot.frameIndex > 0) await shot(page, `${vp.tag}-frame-${(snapshot.frameNumber ?? '').replace('.', '_')}`)
    if (!(await nextFrame(page))) break
    const after = await readFrame(page)
    seen.push(after.frameNumber ?? '')
    if (after.chapter !== first.chapter) break
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
  if (gallery.shots < 1) problems.push('галерея кадра не показывает загруженную картинку')
  if (gallery.loaded < 1) problems.push('картинка галереи не загрузилась (ассет недоступен)')
  if (gallery.sceneImage && !gallery.sceneLoaded) problems.push('фон-картинка кадра не загрузилась')

  if (gallery.shots > 0) {
    await page.locator('.sf-copy__shot').first().click()
    await page.waitForTimeout(500)
    const opened = (await page.evaluate(`!!document.querySelector('.sf-lightbox')`)) as boolean
    await shot(page, `${vp.tag}-lightbox`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    const stillOpen = (await page.evaluate(`!!document.querySelector('.sf-lightbox')`)) as boolean
    console.log(`[${vp.tag}] просмотр картинки: открылся=${opened}, закрылся по Esc=${!stillOpen}`)
    if (!opened) problems.push('клик по картинке галереи не открывает просмотр')
    if (stillOpen) problems.push('просмотр картинки не закрывается по Esc')
  }

  // ── клики по строкам редактора не перехватываются фиксированной стадией
  await page.evaluate(() => {
    document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(700)
  const rowClick = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    const rows = Array.from(document.querySelectorAll('.ed-row'))
    const row = rows[rows.length - 1]
    if (!row) return { ok: false, stage: null, hitClass: null }
    const r = row.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width * 0.6, r.top + r.height / 2)
    return {
      ok: true,
      hitClass: hit ? (typeof hit.className === 'string' ? hit.className : hit.tagName) : null,
      inRow: !!(hit && hit.closest && hit.closest('.ed-row')),
      stage: root ? root.getAttribute('data-stage') : null,
    }
  })()`)) as { ok: boolean; inRow?: boolean; hitClass?: string | null; stage?: string | null }
  console.log(`[${vp.tag}] клик по строке редактора: в строке=${rowClick.inRow} (${rowClick.hitClass}), stage=${rowClick.stage}`)
  if (!rowClick.inRow) problems.push(`клик по строке редактора перехватывает «${rowClick.hitClass}»`)

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
