/**
 * Живая проверка окна помощника и чата проекта телефонным вьюпортом (0.146.0).
 *
 * Что проверяется числами, а не «на глаз»:
 *  1. крестик один и закрывает окно с ОБЕИХ вкладок, цель нажатия ≥ 32px;
 *  2. сообщения — отдельные плашки (у каждого своя рамка/фон), свои — справа;
 *  3. карточки изменений/правок свёрнуты и не съедают переписку (высота ленты сообщений);
 *  4. меню «⋯» у сообщения: цель нажатия ≥ 30px, пункты ≥ 34px, есть «копировать текст»;
 *  5. никакого горизонтального переполнения и текста мельче 12px в переписке;
 *  6. ответ помощника виден: «печатает…» появляется до ответа, текст ответа — после.
 *
 * Запуск (стенд; сессия подставляется, как в diag-assistant-live.ts):
 *   cd frontend
 *   $env:VISUAL_BASE_URL='https://fraze.skynas.ru'
 *   $env:TOKEN=(Get-Content -Raw ..\_dev\jwt.txt)
 *   $env:REFRESH=(Get-Content -Raw ..\_dev\refresh.txt)
 *   $env:PROJECT_ID='7fec44b0-…'
 *   $env:QUESTION='помоги с орфографией и стилем'
 *   npx tsx tests/diag-dock-mobile.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'https://fraze.skynas.ru'
const TOKEN = process.env.TOKEN ?? ''
const REFRESH = process.env.REFRESH ?? ''
const PROJECT_ID = process.env.PROJECT_ID ?? ''
const QUESTION = process.env.QUESTION ?? 'помоги с орфографией и стилем'
const SHOTS = process.env.SHOTS ?? '..\\_dev_shots'
const WAIT_MS = Number(process.env.WAIT_MS ?? 240_000)

type Finding = { level: 'error' | 'warning' | 'info'; what: string }

async function main() {
  if (!TOKEN || !REFRESH || !PROJECT_ID) {
    console.error('нужны TOKEN, REFRESH и PROJECT_ID')
    process.exit(1)
  }
  const findings: Finding[] = []
  const add = (level: Finding['level'], what: string) => findings.push({ level, what })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  await context.addInitScript(
    `(() => {
       localStorage.setItem('skyfraze-auth', JSON.stringify({
         state: { accessToken: ${JSON.stringify(TOKEN)}, refreshToken: ${JSON.stringify(REFRESH)}, user: null, ready: false },
         version: 0,
       }));
     })()`,
  )
  const page = await context.newPage()
  page.on('pageerror', (err) => add('error', `pageerror: ${err.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') add('warning', `console.error: ${msg.text().slice(0, 160)}`)
  })
  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 400) add('warning', `HTTP ${res.status()} ${res.url()}`)
  })

  await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  if (page.url().includes('/login')) {
    await page.goto(`${BASE}/projects/${PROJECT_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
  }

  // Открываем окно: кнопка в доке. Если окно уже открыто (или кнопки нет), ждём панель и,
  // если она не появилась, перезагружаем страницу один раз — сессия могла не успеть примениться.
  const openButton = page.getByRole('button', { name: 'Открыть помощника' })
  if (await openButton.count()) await openButton.click()
  try {
    await page.locator('[data-assistant-panel]').waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
    const retry = page.getByRole('button', { name: 'Открыть помощника' })
    if (await retry.count()) await retry.click()
    await page.locator('[data-assistant-panel]').waitFor({ state: 'visible', timeout: 15_000 })
  }
  await page.waitForTimeout(800)
  const windowBox = await page.locator('[data-assistant-panel]').boundingBox()

  // ── 1. Крестик: один, крупный, закрывает окно с вкладки чата ─────────────
  const closeBox = await page.locator('[data-dock-close]').boundingBox()
  if (!closeBox) add('error', 'крестик окна не найден')
  else {
    if (closeBox.width < 32 || closeBox.height < 32) {
      add('error', `крестик окна мелкий: ${Math.round(closeBox.width)}×${Math.round(closeBox.height)}`)
    } else add('info', `крестик окна: ${Math.round(closeBox.width)}×${Math.round(closeBox.height)}`)
  }
  // Иконка внутри кнопки: кнопка может быть нужного размера и при этом не рисовать крестик
  // (0.146.1 — svg сжимался до нуля из-за padding браузера). Проверяем именно svg.
  const closeIcon = await page.evaluate(() => {
    const svg = document.querySelector('[data-dock-close] svg')
    const r = svg ? svg.getBoundingClientRect() : null
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null
  })
  if (!closeIcon || closeIcon.w < 14 || closeIcon.h < 14) {
    add('error', `иконка крестика не рисуется: ${JSON.stringify(closeIcon)}`)
  } else add('info', `иконка крестика: ${closeIcon.w}×${closeIcon.h}`)
  await page.getByRole('tab', { name: 'Чат проекта' }).click()
  await page.waitForTimeout(800)
  const closeOnChat = await page.locator('[data-dock-close]').boundingBox()
  if (!closeOnChat) add('error', 'на вкладке чата крестика нет')
  else add('info', 'крестик есть на обеих вкладках')
  await page.getByRole('tab', { name: 'Помощник' }).click()
  await page.waitForTimeout(500)

  // ── 2. Вопрос помощнику: «печатает…» до ответа, плашки сообщений ─────────
  const input = page.getByLabel('Сообщение помощнику')
  await input.fill(QUESTION)
  await page.getByRole('button', { name: 'Спросить' }).click()

  let sawTyping = false
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000)
    const state = await page.evaluate(() => {
      const typing = document.querySelector('[data-assistant-thinking]')
      const live = document.querySelector('[data-assistant-live]')
      const cards = Array.from(document.querySelectorAll('[data-assistant-changes], [data-assistant-proposals], [data-assistant-applied]'))
      const log = document.querySelector('[data-assistant-log]')
      return {
        typing: typing ? (typing.textContent ?? '').trim() : '',
        typingIsBubble: typing ? typing.className.includes('ai-msg') : false,
        typingAuthor: typing ? (typing.querySelector('.ai-msg__who')?.textContent ?? '').trim() : '',
        live: live ? (live.textContent ?? '').length : 0,
        cards: cards.map((card) => ({
          tag: card.tagName,
          open: (card as HTMLDetailsElement).open === true,
          height: Math.round(card.getBoundingClientRect().height),
          count: (card.querySelector('.ai-card__count')?.textContent ?? '').trim(),
        })),
        logHeight: log ? Math.round(log.getBoundingClientRect().height) : 0,
      }
    })
    if (state.typing !== '') {
      if (!sawTyping) {
        sawTyping = true
        if (!state.typingIsBubble) add('error', '«печатает…» показано не репликой, а строкой')
        // Имя автора приходит из настроек проекта и до их загрузки может быть «Агент» —
        // важно, что подпись автора есть, а не конкретное имя.
        if (!state.typingAuthor) add('warning', `у «печатает…» нет подписи автора: «${state.typing}»`)
        else add('info', `«печатает…»: автор «${state.typingAuthor}», текст «${state.typing.slice(0, 40)}»`)
      }
    }
    if (state.cards.length > 0) {
      const openCards = state.cards.filter((card) => card.open || card.height > 120)
      if (openCards.length > 0) {
        add('warning', `карточка развёрнута и высокая: ${JSON.stringify(openCards)}`)
      } else {
        add('info', `карточки свёрнуты: ${JSON.stringify(state.cards)}`)
      }
      add('info', `высота переписки при карточках: ${state.logHeight}px`)
    }
    if (state.live > 80) break
  }
  await page.screenshot({ path: `${SHOTS}\\dock-assistant-mobile.png` })

  // Плашки сообщений: у каждого своя рамка (визуальное выделение).
  const bubbles = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-assistant-log] .ai-msg'))
    return items.map((item) => {
      const style = getComputedStyle(item)
      return {
        cls: item.className,
        border: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
        align: style.justifySelf,
        font: parseFloat(style.fontSize),
      }
    })
  })
  for (const bubble of bubbles) {
    if (bubble.border === '0px' || bubble.radius === '0px') {
      add('error', `сообщение без плашки: ${JSON.stringify(bubble)}`)
    }
    if (bubble.font < 12) add('warning', `шрифт сообщения ${bubble.font}px`)
  }
  if (bubbles.length > 0) add('info', `плашек сообщений: ${bubbles.length}, своя выровнена ${bubbles.find((b) => b.cls.includes('--user'))?.align ?? '—'}`)

  // ── 3. Вкладка чата: меню «⋯» и его пункты ───────────────────────────────
  await page.getByRole('tab', { name: 'Чат проекта' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}\\dock-chat-mobile.png` })
  const menuButton = page.locator('[data-chat-menu-button]').first()
  if (await menuButton.count()) {
    const box = await menuButton.boundingBox()
    if (!box || box.width < 30 || box.height < 30) {
      add('error', `кнопка меню мелкая: ${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'нет'}`)
    } else add('info', `кнопка меню сообщения: ${Math.round(box.width)}×${Math.round(box.height)}`)
    await menuButton.click()
    await page.waitForTimeout(400)
    const items = await page.evaluate(() => {
      const menu = document.querySelector('[data-chat-menu]')
      if (!menu) return null
      const rect = menu.getBoundingClientRect()
      const buttons = Array.from(menu.querySelectorAll('button'))
      return {
        width: Math.round(rect.width),
        right: Math.round(rect.right),
        viewport: window.innerWidth,
        items: buttons.map((button) => ({
          text: (button.textContent ?? '').trim(),
          height: Math.round(button.getBoundingClientRect().height),
        })),
      }
    })
    if (!items) add('error', 'меню действий не открылось')
    else {
      const copy = items.items.find((item) => item.text.includes('копировать'))
      if (!copy) add('error', 'в меню нет «копировать текст»')
      const small = items.items.filter((item) => item.height < 34)
      if (small.length > 0) add('error', `мелкие пункты меню: ${JSON.stringify(small)}`)
      if (items.right > items.viewport) add('error', `меню вылезло за экран: right=${items.right} > ${items.viewport}`)
      add('info', `меню: ширина ${items.width}px, пунктов ${items.items.length}`)
    }
    await page.screenshot({ path: `${SHOTS}\\dock-chat-menu-mobile.png` })
    await page.keyboard.press('Escape')
  } else {
    add('warning', 'сообщений в чате проекта нет — меню проверить не на чем')
  }

  // ── 4. Общее: горизонтальный скролл и мелкий текст ───────────────────────
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    small: Array.from(document.querySelectorAll('[data-assistant-panel] *'))
      .filter((el) => {
        const text = (el.textContent ?? '').trim()
        if (!text || el.children.length > 0) return false
        const style = getComputedStyle(el)
        return parseFloat(style.fontSize) < 11
      })
      .slice(0, 5)
      .map((el) => `${el.className}:${getComputedStyle(el).fontSize}`),
  }))
  if (overflow.doc > 1) add('error', `горизонтальный скролл документа: +${overflow.doc}px`)
  else add('info', 'горизонтального скролла нет')
  if (overflow.small.length > 0) add('warning', `мелкий текст: ${overflow.small.join(', ')}`)

  // ── Отчёт ────────────────────────────────────────────────────────────────
  const order = { error: 0, warning: 1, info: 2 }
  findings.sort((a, b) => order[a.level] - order[b.level])
  console.log(`\nвьюпорт 390×844, окно: ${windowBox ? `${Math.round(windowBox.width)}×${Math.round(windowBox.height)}` : 'нет'}`)
  for (const finding of findings) console.log(`[${finding.level}] ${finding.what}`)
  const errors = findings.filter((f) => f.level === 'error').length
  console.log(`\nошибок: ${errors}, предупреждений: ${findings.filter((f) => f.level === 'warning').length}`)
  console.log(`скриншоты: ${SHOTS}\\dock-assistant-mobile.png, dock-chat-mobile.png, dock-chat-menu-mobile.png`)
  await browser.close()
  if (errors > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
