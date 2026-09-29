/**
 * ui-visual-audit — раннер проверки панели SkyFraze.
 *
 * Две части:
 *   1) ВИЗУАЛ: проходит экраны во всех вьюпортах и темах, снимает скриншоты и
 *      считает геометрию/контраст/hit-test — находит «съехавшее», обрезанное,
 *      недоступное для клика и незагруженные картинки.
 *   2) ФУНКЦИИ: прогоняет матрицу заявленных возможностей (проекты, иерархия,
 *      ассеты, темы, роли/приглашения, realtime CRDT) и проверяет результат.
 *
 * Запуск (из каталога frontend):
 *   npx tsx ../.dsh/skills/ui-visual-audit/scripts/visual-audit.ts
 *   ONLY_SCREENS=1 …   ONLY_FUNCTIONAL=1 …
 *
 * Результат: _audit_out/visual-report.md, _audit_out/visual-report.json, скриншоты.
 * Код выхода 1, если есть findings уровня error.
 */
import type { Browser, BrowserContext, Page } from 'playwright'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

/**
 * Playwright живёт в frontend/node_modules, а скрипт — в скилле вне проекта,
 * поэтому подгружаем модуль по абсолютному пути (запускать из каталога frontend).
 */
async function loadPlaywright(): Promise<typeof import('playwright')> {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.resolve(process.cwd(), 'node_modules/playwright'),
    path.resolve(process.cwd(), '../frontend/node_modules/playwright'),
    'C:/Projects/SkyFraze/frontend/node_modules/playwright',
  ].filter((v): v is string => Boolean(v))
  const unwrap = (mod: unknown): typeof import('playwright') | null => {
    const m = mod as { chromium?: unknown; default?: { chromium?: unknown } }
    if (m?.chromium) return mod as typeof import('playwright')
    if (m?.default?.chromium) return m.default as typeof import('playwright')
    return null
  }
  for (const dir of candidates) {
    try {
      const resolved = unwrap(await import(pathToFileURL(path.join(dir, 'index.js')).href))
      if (resolved) return resolved
    } catch {
      /* пробуем следующий путь */
    }
  }
  const fallback = unwrap(await import('playwright'))
  if (!fallback) throw new Error('playwright не найден: запусти скрипт из каталога frontend')
  return fallback
}

const BASE = process.env.BASE_URL ?? 'http://localhost'
const OUT = process.env.AUDIT_OUT ?? 'C:/Projects/SkyFraze/_audit_out'
const EMAIL = process.env.AUDIT_EMAIL ?? 'galactic.test@e.com'
const PASS = process.env.AUDIT_PASS ?? 'hunter22!'
const DEMO_ID = (process.env.AUDIT_PROJECT ?? 'b8938a83-3b39-42ba-9edd-e0d6c206c548').split('/').filter(Boolean).pop() as string
const DEMO = `/projects/${DEMO_ID}`
const ONLY_SCREENS = process.env.ONLY_SCREENS === '1'
const ONLY_FUNCTIONAL = process.env.ONLY_FUNCTIONAL === '1'

type Severity = 'error' | 'warning' | 'info'

interface Finding {
  severity: Severity
  area: 'visual' | 'functional'
  screen: string
  viewport: string
  check: string
  detail: string
  where: string
  shot?: string
}

const findings: Finding[] = []
const shots: string[] = []

function add(f: Finding) {
  findings.push(f)
}
function pass(screen: string, viewport: string, check: string) {
  add({ severity: 'info', area: 'functional', screen, viewport, check, detail: 'ok', where: '—' })
}

const VIEWPORTS = [
  { width: 1440, height: 900, tag: 'desktop' },
  { width: 1024, height: 768, tag: 'tablet' },
  { width: 390, height: 844, tag: 'mobile' },
  // Маленький телефон (4", iPhone SE): именно здесь вылезала шапка, из-за чего
  // браузер расширял layout viewport и масштабировал страницу — фиксированные
  // слои стадии уезжали за экран. Без этого вьюпорта дефект не ловился.
  { width: 320, height: 568, tag: 'mobile-small' },
]
const THEMES = ['dark', 'light'] as const

// ─────────────────────────────────────────────────────────── визуальный зонд

const PROBE = `(() => {
  const out = { docOverflow: 0, clipped: [], outside: [], smallTargets: [], brokenImages: [], lowContrast: [], hiddenHit: [], overlaps: [], tiny: [] }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const isVisible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
  }
  const insideStage = (el) => !!(el.closest && el.closest('.sf-stage'))
  const inScroller = (el) => {
    let cur = el.parentElement
    while (cur) {
      const cs = getComputedStyle(cur)
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1) return true
      cur = cur.parentElement
    }
    return false
  }

  out.docOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)

  // Картинки.
  // Ошибка — только «загрузилась и битая». Ещё не начатая (lazy вне экрана) и
  // находящаяся в полёте картинка — не дефект: иначе аудит ругается на обложку
  // ленты, которая просто не успела догрузиться за время проверки.
  document.querySelectorAll('img').forEach((img) => {
    if (!isVisible(img)) return
    const r = img.getBoundingClientRect()
    const onScreen = r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0)
    if (img.loading === 'lazy' && !onScreen) return
    if (!img.complete) return
    if (img.naturalWidth === 0) out.brokenImages.push({ sel: describe(img), src: (img.currentSrc || img.src || '').slice(0, 90) })
  })

  // Текст: обрезание и мелкий кегль
  document.querySelectorAll('h1,h2,h3,h4,p,span,li,strong,em,label,button,a,div').forEach((el) => {
    if (!isVisible(el) || insideStage(el)) return
    const text = (el.textContent || '').trim()
    if (text.length === 0) return
    const hasElementChildWithText = Array.from(el.children).some((c) => ((c.textContent || '').trim().length > 0))
    const cs = getComputedStyle(el)
    const size = parseFloat(cs.fontSize)
    if (!hasElementChildWithText) {
      if (size < 12) out.tiny.push({ sel: describe(el), size: Math.round(size), text: text.slice(0, 24) })
      const ellipsis = cs.textOverflow === 'ellipsis' && (cs.whiteSpace === 'nowrap' || cs.overflow === 'hidden')
      if (!ellipsis && el.scrollWidth > el.clientWidth + 1) {
        out.clipped.push({ sel: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: text.slice(0, 40) })
      }
    }
  })

  // Вне вьюпорта + малые цели + hit-test
  // Вне вьюпорта + малые цели + hit-test (только для реально видимых элементов:
  // строка, уехавшая в скроллере, «перехвачена» лишь потому, что её там нет)
  const fullyVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    let cur = el.parentElement
    while (cur) {
      const cs = getComputedStyle(cur)
      const clipped = cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible'
      if (clipped) {
        const cr = cur.getBoundingClientRect()
        const inside = r.top >= cr.top - 2 && r.bottom <= cr.bottom + 2 && r.left >= cr.left - 2 && r.right <= cr.right + 2
        if (!inside) return false
      }
      cur = cur.parentElement
    }
    return true
  }
  const interactive = Array.from(document.querySelectorAll('button,a,input,select,textarea,[role="button"]'))
    .filter(isVisible)
    .filter((el) => !insideStage(el))
    .filter(fullyVisible)

  interactive.forEach((el) => {
    const r = el.getBoundingClientRect()
    // Горизонтальный скроллер (чипы глав) — элементы за краем это норма.
    let inHScroller = false
    let probe = el.parentElement
    while (probe) {
      const cs = getComputedStyle(probe)
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && probe.scrollWidth > probe.clientWidth + 1) {
        inHScroller = true
        break
      }
      probe = probe.parentElement
    }
    if (!inHScroller && (r.left < -2 || r.right > vw + 2)) {
      out.outside.push({ sel: describe(el), axis: 'x', left: Math.round(r.left), right: Math.round(r.right) })
    }
    // Вертикаль: элемент ниже сгиба в скроллящейся странице — это норма.
    // Ошибка только когда его нечем доскроллить (панель с overflow: hidden).
    const scrollableAncestor = (node) => {
      let cur = node.parentElement
      while (cur) {
        const cs = getComputedStyle(cur)
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) return true
        cur = cur.parentElement
      }
      return document.scrollingElement.scrollHeight > window.innerHeight + 1
    }
    const clippedByHidden = (() => {
      let cur = el
      while (cur) {
        const cs = getComputedStyle(cur)
        if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') return true
        cur = cur.parentElement
      }
      return false
    })()
    if ((r.top < -2 || r.bottom > vh + 2) && clippedByHidden && !scrollableAncestor(el)) {
      out.outside.push({ sel: describe(el), axis: 'y', top: Math.round(r.top), bottom: Math.round(r.bottom) })
    }
    if (vw <= 480 && (r.width < 32 || r.height < 32)) {
      out.smallTargets.push({ sel: describe(el), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim().slice(0, 20) })
    }
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx > 0 && cy > 0 && cx < vw && cy < vh) {
      const hit = document.elementFromPoint(cx, cy)
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        out.hiddenHit.push({ sel: describe(el), hit: describe(hit) })
      }
    }
  })

  // Пересечения интерактивных элементов (кроме вложенных)
  for (let i = 0; i < interactive.length && out.overlaps.length < 8; i++) {
    for (let j = i + 1; j < interactive.length && out.overlaps.length < 8; j++) {
      const a = interactive[i]
      const b = interactive[j]
      if (a.contains(b) || b.contains(a)) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (ox > 6 && oy > 6) {
        out.overlaps.push({ a: describe(a), b: describe(b), ox: Math.round(ox), oy: Math.round(oy) })
      }
    }
  }

  // Контраст текста к ближайшему непрозрачному фону
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || '')
    if (!m) return null
    const p = m[1].split(',').map((v) => parseFloat(v))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const bgOf = (el) => {
    let cur = el
    while (cur) {
      const cs = getComputedStyle(cur)
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'image'
      const bg = parse(cs.backgroundColor)
      if (bg && bg.a > 0.6) return bg
      cur = cur.parentElement
    }
    return null
  }
  document.querySelectorAll('h1,h2,h3,h4,p,span,li,label,button,a').forEach((el) => {
    if (!isVisible(el) || insideStage(el)) return
    const text = (el.textContent || '').trim()
    if (text.length < 2) return
    if (Array.from(el.children).some((c) => ((c.textContent || '').trim().length > 0))) return
    const fg = parse(getComputedStyle(el).color)
    const bg = bgOf(el)
    if (!fg || bg === 'image' || !bg) return
    const l1 = lum(fg)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    if (ratio < 3.5) out.lowContrast.push({ sel: describe(el), ratio: Math.round(ratio * 100) / 100, text: text.slice(0, 24) })
  })

  return out
})()`

interface ProbeResult {
  docOverflow: number
  clipped: Array<{ sel: string; scrollWidth: number; clientWidth: number; text: string }>
  outside: Array<{ sel: string; axis: string; left?: number; right?: number; top?: number; bottom?: number }>
  smallTargets: Array<{ sel: string; w: number; h: number; text: string }>
  brokenImages: Array<{ sel: string; src: string }>
  lowContrast: Array<{ sel: string; ratio: number; text: string }>
  hiddenHit: Array<{ sel: string; hit: string }>
  overlaps: Array<{ a: string; b: string; ox: number; oy: number }>
  tiny: Array<{ sel: string; size: number; text: string }>
}

async function probe(page: Page): Promise<ProbeResult> {
  await settleImages(page)
  return (await page.evaluate(PROBE)) as ProbeResult
}

/**
 * Даёт уже начатым картинкам шанс догрузиться (короткий таймаут, не networkidle:
 * на страницах со WebSocket networkidle не наступает никогда).
 */
async function settleImages(page: Page, timeoutMs = 2500): Promise<void> {
  await page
    .evaluate(`(async () => {
      const pending = Array.from(document.images).filter((i) => !i.complete)
      if (pending.length === 0) return
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((res) => {
          i.addEventListener('load', res, { once: true })
          i.addEventListener('error', res, { once: true })
        }))),
        new Promise((res) => setTimeout(res, ${timeoutMs})),
      ])
    })()`)
    .catch(() => null)
}

function applyProbe(result: ProbeResult, screen: string, viewport: string, shot: string) {
  const V = 'visual'
  if (result.docOverflow > 2) {
    add({ severity: 'error', area: V, screen, viewport, check: 'горизонтальный скролл документа', detail: `${result.docOverflow}px`, where: 'layout/main или широкий элемент', shot })
  }
  for (const c of result.clipped.slice(0, 6)) {
    add({ severity: 'warning', area: V, screen, viewport, check: 'обрезанный текст', detail: `${c.sel}: ${c.scrollWidth}>${c.clientWidth} «${c.text}»`, where: 'CSS этого компонента (max-width/overflow-wrap)', shot })
  }
  for (const o of result.outside.slice(0, 6)) {
    add({ severity: 'error', area: V, screen, viewport, check: 'элемент вне вьюпорта', detail: `${o.sel} (${o.axis}: ${o.left ?? o.top}..${o.right ?? o.bottom})`, where: 'позиционирование/размеры компонента', shot })
  }
  for (const s of result.smallTargets.slice(0, 6)) {
    add({ severity: 'warning', area: V, screen, viewport, check: 'мелкая цель нажатия', detail: `${s.sel} ${s.w}×${s.h} «${s.text}»`, where: 'padding/min-height кнопки', shot })
  }
  for (const b of result.brokenImages.slice(0, 6)) {
    add({ severity: 'error', area: V, screen, viewport, check: 'картинка не загрузилась', detail: `${b.sel} ${b.src}`, where: 'auth ассетов / путь к файлу', shot })
  }
  for (const c of result.lowContrast.slice(0, 6)) {
    add({ severity: 'warning', area: V, screen, viewport, check: 'низкий контраст', detail: `${c.sel} ${c.ratio}:1 «${c.text}»`, where: 'цвет текста/фона', shot })
  }
  for (const h of result.hiddenHit.slice(0, 6)) {
    add({ severity: 'error', area: V, screen, viewport, check: 'клик перехвачен другим элементом', detail: `${h.sel} ← ${h.hit}`, where: 'z-index/pointer-events/fixed-слой', shot })
  }
  for (const o of result.overlaps.slice(0, 6)) {
    add({ severity: 'warning', area: V, screen, viewport, check: 'пересечение интерактивных элементов', detail: `${o.a} ∩ ${o.b} (${o.ox}×${o.oy})`, where: 'раскладка (grid/flex) или отступы', shot })
  }
  for (const t of result.tiny.slice(0, 4)) {
    add({ severity: 'info', area: V, screen, viewport, check: 'мелкий шрифт', detail: `${t.sel} ${t.size}px «${t.text}»`, where: 'типографика', shot })
  }
  // Явная фиксация пройденных классов проверок: иначе экран без замечаний вообще
  // не оставляет следа в отчёте и кажется, что визуальная часть не выполнялась.
  const clean: Array<[boolean, string]> = [
    [result.clipped.length === 0, 'текст не обрезан'],
    [result.outside.length === 0, 'всё внутри вьюпорта'],
    [result.smallTargets.length === 0, 'цели нажатия достаточного размера'],
    [result.brokenImages.length === 0, 'все картинки загрузились'],
    [result.lowContrast.length === 0, 'контраст текста в норме'],
    [result.hiddenHit.length === 0, 'клики доходят до элементов'],
    [result.overlaps.length === 0, 'интерактивные элементы не пересекаются'],
    [result.tiny.length === 0, 'нет текста мельче 12px'],
  ]
  for (const [ok, check] of clean) {
    if (ok) add({ severity: 'info', area: V, screen, viewport, check, detail: 'ok', where: '—', shot })
  }
}

// ─────────────────────────────────────────────────────────── вспомогательное

async function shot(page: Page, name: string): Promise<string> {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(file)
  return name
}

/** Выбирает в редакторе событие, чей кадр сейчас показан на стадии. */
async function selectEditorRowForFrame(page: Page): Promise<boolean> {
  const title = (await page.evaluate(
    `(() => (document.querySelector('.sf-copy__title') || {}).textContent || '')()`,
  )) as string
  const short = (title || '').trim().slice(0, 16)
  if (!short) return false
  const row = page.locator('.ed-row', { hasText: short }).first()
  if ((await row.count()) === 0) return false
  await row.click()
  await page.waitForTimeout(350)
  return true
}

/** Возвращает стадию к началу трека и переходит на кадр с индексом step. */
async function gotoFrame(page: Page, step: number) {
  await page.evaluate(() => {
    const main = document.querySelector('.layout main')
    if (main) main.scrollTop = 0
  })
  await settleFrame(page)
  for (let i = 0; i < step; i++) {
    const button = page.locator('.sf-copy__nav .sf-btn--primary')
    if (await button.isDisabled().catch(() => true)) break
    await button.click()
    await settleFrame(page)
  }
}

async function login(page: Page, email = EMAIL, pass = PASS) {
  // Вход проверяем по факту попадания на страницу проектов, а не по таймауту:
  // под нагрузкой (параллельные сборки/тесты) 1.5 секунды не хватало, и дальше
  // аудит падал на «нет кнопки + Новый проект» — то есть на своём же нетерпении.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE}/login`)
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', pass)
    await page.click('button[type="submit"]')
    try {
      await page.waitForURL(/\/projects/, { timeout: 25000 })
      await page.waitForSelector('button:has-text("+ Новый проект")', { timeout: 25000 })
      return
    } catch {
      // одна повторная попытка: сеть могла мигнуть, токен — не успеть
    }
  }
  throw new Error('не удалось войти: кнопка «+ Новый проект» так и не появилась')
}

async function setTheme(page: Page, theme: 'dark' | 'light', reload = true) {
  const current = (await page.evaluate(`document.documentElement.dataset.theme || 'dark'`)) as string
  await page.evaluate((t) => window.localStorage.setItem('skyfraze-theme', t), theme)
  if (current === theme) return
  if (!reload) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t
    }, theme)
    await page.waitForTimeout(400)
    return
  }
  // Перезагрузка нужна, чтобы приложение поднялось с темой из хранилища:
  // прямая правка dataset.theme не обновляет стор темы (палитра кадров).
  await page.reload()
  await page.waitForTimeout(1600)
}

async function settleFrame(page: Page, timeoutMs = 4000): Promise<string | null> {
  const started = Date.now()
  let previous: string | null = null
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const current = (await page.evaluate(
      `(() => { const r = document.querySelector('.sf-root'); return r ? r.getAttribute('data-frame-number') : null })()`,
    )) as string | null
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

// ─────────────────────────────────────────────────────────── визуальная часть

/** Демо-проект должен быть опубликован, иначе публичных экранов просто нет.
 *  Операция идемпотентна: повторный вызов не меняет ссылку. */
async function ensurePublicStory(): Promise<string | null> {
  try {
    const token = await apiLogin()
    const id = DEMO.split('/').filter(Boolean).pop() as string
    await fetch(`${BASE}/api/projects/${id}/publication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_public: true }),
    })
    const res = await fetch(`${BASE}/api/public/feed`)
    const json = (await res.json()) as { items: Array<{ id: string; slug: string }> }
    return json.items.find((i) => i.id === id)?.slug ?? json.items[0]?.slug ?? null
  } catch {
    return null
  }
}

/** Публичные страницы глазами анонима: их видно без входа, правок на них нет. */
async function visualPublic(browser: Browser, errors: string[], slug: string | null) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  for (const theme of THEMES) {
    await page.goto(`${BASE}/feed`)
    await setTheme(page, theme)
    await page.waitForTimeout(900)
    let name = `anon-${theme}-feed`
    await shot(page, name)
    applyProbe(await probe(page), 'feed:anon', 'desktop', name)

    if (!slug) continue
    await page.goto(`${BASE}/s/${slug}`)
    await page.waitForSelector('.sf-track', { timeout: 20000 }).catch(() => null)
    await page.waitForTimeout(1200)
    name = `anon-${theme}-story`
    await shot(page, name)
    applyProbe(await probe(page), 'story:anon', 'desktop', name)
  }
  await ctx.close()
}

async function visualScreens(browser: Browser, errors: string[], slug: string | null) {
  for (const vp of VIEWPORTS) {
    // Один контекст на вьюпорт: логинимся один раз, темы переключаем внутри.
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      reducedMotion: 'reduce',
    })
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url ?? ''}`) })
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

    await page.goto(`${BASE}/login`)
    await page.waitForTimeout(500)
    for (const theme of THEMES) {
      await setTheme(page, theme)
      let name = `${vp.tag}-${theme}-login`
      await shot(page, name)
      applyProbe(await probe(page), 'login', vp.tag, name)
    }

    // Вход — через хелпер login(): он ждёт попадания на страницу проектов и
    // повторяет попытку. Фиксированная пауза не выдерживала на холодном стенде
    // (первый вьюпорт медленнее всех): следующий переход обрывал ещё летящий
    // запрос входа, и аудит уезжал на /login вместо стадии.
    await login(page)

    for (const theme of THEMES) {
      console.log(`[visual] ${vp.tag}/${theme}`)
      await setTheme(page, theme)

      // projects
      await page.goto(`${BASE}/projects`)
      await page.waitForTimeout(900)
      let name = `${vp.tag}-${theme}-projects`
      await shot(page, name)
      applyProbe(await probe(page), 'projects', vp.tag, name)

      // соавторы: поиск людей по нику, специализации, доступ к закрытым проектам
      await page.goto(`${BASE}/coauthors`)
      await page.waitForSelector('[data-profile]', { timeout: 20000 }).catch(() => null)
      await page.waitForTimeout(700)
      name = `${vp.tag}-${theme}-coauthors`
      await shot(page, name)
      applyProbe(await probe(page), 'coauthors', vp.tag, name)
      const coauthorState = (await page.evaluate(`(() => {
        const nick = document.querySelector('[data-profile] input[aria-label="Ваш ник"]')
        const search = document.querySelector('input[aria-label="Поиск людей по нику или имени"]')
        return {
          hasProfile: !!document.querySelector('[data-profile]'),
          nick: nick ? nick.value : null,
          hasSearch: !!search,
          coauthors: document.querySelectorAll('[data-coauthors] .coauthors__row').length,
        }
      })()`)) as { hasProfile: boolean; nick: string | null; hasSearch: boolean; coauthors: number }
      if (!coauthorState.hasProfile || !coauthorState.hasSearch) {
        add({
          severity: 'error', area: 'visual', screen: 'coauthors', viewport: vp.tag,
          check: 'страница соавторов', detail: JSON.stringify(coauthorState),
          where: 'CoauthorsPage',
        })
      } else {
        pass('coauthors', vp.tag, `соавторов: ${coauthorState.coauthors}, ник: @${coauthorState.nick}`)
      }
      if (!coauthorState.nick) {
        add({
          severity: 'error', area: 'functional', screen: 'coauthors', viewport: vp.tag,
          check: 'ник пользователя', detail: 'пустой ник — человека не найти поиском',
          where: 'auth/service.go (генерация ника) / ProfileCard',
        })
      }

      // timeline: проходим все кадры
      const demoUrl = `${BASE}${DEMO.startsWith('/') ? DEMO : '/' + DEMO}`
      await page.goto(demoUrl)
      try {
        await page.waitForSelector('.sf-root', { timeout: 25000 })
      } catch {
        const where = page.url()
        add({ severity: 'error', area: 'visual', screen: 'timeline', viewport: vp.tag, check: 'стадия не открылась', detail: `url=${where}`, where: 'ProjectTimelinePage / доступ к проекту' })
        continue
      }
      await page.waitForTimeout(2500)
      // Трек переключает кадры сцены на любой ширине: на телефоне кадры тоже идут
      // друг за другом (текст события, снимок, следующее событие), просто по одному
      // на экран. Прокручиваем трек целиком и снимаем кадры по дороге.
      const geo = (await page.evaluate(`(() => {
        const main = document.querySelector('.layout main')
        const track = document.querySelector('.sf-track')
        const mr = main.getBoundingClientRect()
        if (!track) {
          return { top: 0, height: main.scrollHeight, viewport: main.clientHeight }
        }
        const tr = track.getBoundingClientRect()
        return { top: mr.top * -1 + tr.top + main.scrollTop, height: tr.height, viewport: main.clientHeight }
      })()`)) as { top: number; height: number; viewport: number }
      const steps = vp.tag === 'desktop' ? 36 : 24
      for (let i = 0; i <= steps; i++) {
        await page.evaluate((y) => {
          const main = document.querySelector('.layout main')
          if (main) main.scrollTop = y
        }, geo.top + (i / steps) * Math.max(1, geo.height - geo.viewport))
        await page.waitForTimeout(140)
        if (i % Math.ceil(steps / 4) === 0) {
          const frame = (await page.evaluate(`(() => {
            const r = document.querySelector('.sf-root')
            return r ? r.getAttribute('data-frame-number') : ''
          })()`)) as string
          name = `${vp.tag}-${theme}-frame-${frame || i}`
          await shot(page, name)
          applyProbe(await probe(page), `timeline:${frame}`, vp.tag, name)
        }
      }

      // редакторы
      await page.evaluate(() => {
        document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
      })
      await page.waitForTimeout(900)
      name = `${vp.tag}-${theme}-editors`
      await shot(page, name)
      applyProbe(await probe(page), 'editors', vp.tag, name)

      // настройки
      await page.goto(`${BASE}/projects/${DEMO.split('/').pop()}/settings`)
      await page.waitForTimeout(1100)
      name = `${vp.tag}-${theme}-settings`
      await shot(page, name)
      applyProbe(await probe(page), 'settings', vp.tag, name)

      // админка развёртывания (доступна, если тестовый аккаунт — администратор)
      await page.goto(`${BASE}/admin`)
      await page.waitForTimeout(1100)
      name = `${vp.tag}-${theme}-admin`
      await shot(page, name)
      applyProbe(await probe(page), 'admin', vp.tag, name)

      // публичная лента и публичная история (для вошедшего вид тот же)
      await page.goto(`${BASE}/feed`)
      await page.waitForTimeout(1000)
      name = `${vp.tag}-${theme}-feed`
      await shot(page, name)
      applyProbe(await probe(page), 'feed', vp.tag, name)

      if (slug) {
        await page.goto(`${BASE}/s/${slug}`)
        await page.waitForSelector('.sf-track', { timeout: 20000 }).catch(() => null)
        await page.waitForTimeout(1200)
        name = `${vp.tag}-${theme}-story`
        await shot(page, name)
        applyProbe(await probe(page), 'story', vp.tag, name)
      }
    }

    await ctx.close()
  }
}

// ─────────────────────────────────────────────────────────── функциональная часть

async function apiLogin(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  const json = (await res.json()) as { tokens: { access: string } }
  return json.tokens.access
}

/**
 * Создаёт тестового пользователя так, как это сделал бы человек на этой инсталляции:
 * при открытой регистрации — прямой регистрацией, при режиме «по заявке» — заявкой
 * и её одобрением администратором. Без этого аудит ломается о собственную же
 * настройку «только по заявке».
 */
async function ensureTestUser(
  email: string,
  displayName: string,
  password = 'hunter22!',
): Promise<{ ok: boolean; note: string }> {
  const register = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName }),
  })
  if (register.ok) return { ok: true, note: 'прямая регистрация' }
  if (register.status !== 403) return { ok: false, note: `register ${register.status}` }

  const requested = await fetch(`${BASE}/api/auth/registration-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: displayName, message: 'тестовый пользователь аудита' }),
  })
  if (requested.status !== 202) return { ok: false, note: `request ${requested.status}` }

  const token = await apiLogin()
  const listRes = await fetch(`${BASE}/api/admin/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const list = (await listRes.json()) as { requests: Array<{ id: string; email: string }> }
  const found = list.requests.find((r) => r.email === email)
  if (!found) return { ok: false, note: 'заявка не найдена в списке админа' }

  const approved = await fetch(`${BASE}/api/admin/registrations/${found.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!approved.ok) return { ok: false, note: `approve ${approved.status}` }

  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return { ok: loginRes.ok, note: loginRes.ok ? 'заявка одобрена админом' : `login ${loginRes.status}` }
}

async function functional(browser: Browser, errors: string[]) {
  const V = 'desktop'
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

  await login(page)

  // 1. Создание проекта
  const projectName = `Audit ${Date.now()}`
  await page.goto(`${BASE}/projects`)
  await page.waitForTimeout(800)
  await page.click('button:has-text("+ Новый проект")')
  await page.fill('input[placeholder="Название"]', projectName)
  await page.fill('textarea', 'Проект для автоаудита')
  await page.click('button:has-text("Создать")')
  await page.waitForSelector('h3 a')
  await page.locator('h3 a', { hasText: projectName }).first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(1500)
  const projectId = page.url().split('/').pop() as string
  pass('projects', V, 'создание проекта')

  // 2. Иерархия: глава → под-событие → внук
  await page.click('button:has-text("+ Добавить первую главу")')
  await page.waitForTimeout(700)
  await page.fill('.ed-form input[placeholder="Заголовок события"]', 'Глава аудита')
  await page.fill('.ed-form textarea', 'Описание главы для проверки вместимости текста и кадра.')
  await page.waitForTimeout(300)
  await page.click('.ed-toolbar button:has-text("+ подсобытие")')
  await page.waitForTimeout(600)
  await page.fill('.ed-form input[placeholder="Заголовок события"]', 'Подсобытие аудита')
  await page.waitForTimeout(300)
  await page.click('.ed-toolbar button:has-text("+ подсобытие")')
  await page.waitForTimeout(600)
  await page.fill('.ed-form input[placeholder="Заголовок события"]', 'Внук аудита')
  await page.waitForTimeout(400)

  await page.evaluate(() => {
    const main = document.querySelector('.layout main')
    if (main) main.scrollTop = 0
  })
  await settleFrame(page)
  const hierarchy = (await page.evaluate(`(() => {
    const root = document.querySelector('.sf-root')
    return {
      frames: Number(root.getAttribute('data-frames-in-chapter')),
      frame: root.getAttribute('data-frame-number'),
    }
  })()`)) as { frames: number; frame: string }
  if (hierarchy.frames < 3) {
    add({ severity: 'error', area: 'functional', screen: 'timeline', viewport: V, check: 'иерархия событий', detail: `кадров в главе ${hierarchy.frames}, ожидалось 3`, where: 'EditorsPanel/ timelineModel' })
  } else {
    pass('timeline', V, `иерархия: ${hierarchy.frames} кадра`)
  }

  // 3. Сквозная навигация кадров
  const sequence: string[] = [hierarchy.frame ?? '']
  for (let i = 0; i < 6; i++) {
    const button = page.locator('.sf-copy__nav .sf-btn--primary')
    if (await button.isDisabled().catch(() => true)) break
    await button.click()
    await settleFrame(page)
    const frame = (await page.evaluate(`(() => document.querySelector('.sf-root').getAttribute('data-frame-number'))()`)) as string
    sequence.push(frame)
  }
  const expected = ['01', '01.1', '01.1.1']
  if (!expected.every((e, i) => sequence[i] === e)) {
    add({ severity: 'error', area: 'functional', screen: 'timeline', viewport: V, check: 'навигация по кадрам', detail: `последовательность ${sequence.join(' → ')}`, where: 'TimelineStage/CopyPanel' })
  } else {
    pass('timeline', V, `навигация: ${sequence.slice(0, 3).join(' → ')}`)
  }

  // 4. Загрузка файла: малый и 2.5 МБ (файл прикрепляем к событию показанного кадра)
  await gotoFrame(page, 1)
  await selectEditorRowForFrame(page)

  const small = path.join(OUT, 'upload-small.png')
  const big = path.join(OUT, 'upload-big.png')
  const pngHeader = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoC251gfbC0iCpmkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4NfYAAT8B1WQAAAAASUVORK5CYII=', 'base64')
  fs.writeFileSync(small, pngHeader)
  fs.writeFileSync(big, Buffer.concat([pngHeader, crypto.randomBytes(2_500_000)]))

  for (const [label, file] of [['малый', small], ['2.5 МБ', big]] as const) {
    const before = (await page.evaluate(`document.querySelectorAll('.ed-assets__item').length`)) as number
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null)
    await page.locator('.ed-upload').click()
    const chooser = await chooserPromise
    if (!chooser) {
      add({ severity: 'error', area: 'functional', screen: 'editors', viewport: V, check: `загрузка файла (${label})`, detail: 'диалог выбора файла не открылся', where: 'EventEditor: control .ed-upload' })
      continue
    }
    await chooser.setFiles(file)
    let after = before
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500)
      after = (await page.evaluate(`document.querySelectorAll('.ed-assets__item').length`)) as number
      if (after > before) break
    }
    if (after <= before) {
      add({ severity: 'error', area: 'functional', screen: 'editors', viewport: V, check: `загрузка файла (${label})`, detail: 'файл не прикрепился (проверь nginx client_max_body_size и /api/assets)', where: 'nginx.conf / EditorsPanel.uploadAndAttach' })
    } else {
      pass('editors', V, `загрузка файла (${label})`)
    }
  }

  // 5. Галерея + просмотр
  await gotoFrame(page, 1)
  const gallery = (await page.evaluate(`(() => {
    const imgs = Array.from(document.querySelectorAll('.sf-copy__shot img'))
    return { count: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }
  })()`)) as { count: number; loaded: number }
  if (gallery.count === 0 || gallery.loaded === 0) {
    add({ severity: 'error', area: 'functional', screen: 'timeline', viewport: V, check: 'галерея кадра', detail: `картинок ${gallery.count}, загружено ${gallery.loaded}`, where: 'assetObject.ts / CopyPanel' })
  } else {
    pass('timeline', V, `галерея: ${gallery.loaded}/${gallery.count} картинок`)
    // Просмотр — отдельный слой поверх сайта со свайпом и стрелками, а не
    // вложенное окно внутри прокручиваемой панели кадра.
    await page.locator('.sf-copy__shot').first().click()
    await page.waitForSelector('.sf-viewer', { timeout: 5000 }).catch(() => undefined)
    const viewer = (await page.evaluate(`(() => {
      const v = document.querySelector('.sf-viewer')
      if (!v) return null
      const img = v.querySelector('.sf-viewer__img')
      const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
      return {
        index: Number(v.getAttribute('data-viewer-index')),
        total: Number(v.getAttribute('data-viewer-total')),
        counter: (v.querySelector('.sf-viewer__count')?.textContent || '').trim(),
        imgLoaded: img ? img.complete && img.naturalWidth > 0 : false,
        topLayer: !!(hit && hit.closest && hit.closest('.sf-viewer')),
        navs: v.querySelectorAll('.sf-viewer__nav').length,
      }
    })()`)) as Record<string, unknown> | null
    let flip = true
    if (viewer && Number(viewer.total) > 1) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(300)
      flip = (await page.evaluate(`Number(document.querySelector('.sf-viewer')?.getAttribute('data-viewer-index'))`)) === 1
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const closed = !(await page.evaluate(`!!document.querySelector('.sf-viewer')`)) as boolean
    const viewerOk =
      !!viewer &&
      viewer.topLayer === true &&
      viewer.navs === 2 &&
      viewer.imgLoaded === true &&
      Number(viewer.total) === gallery.count &&
      flip &&
      closed
    if (!viewerOk) {
      add({
        severity: 'error', area: 'functional', screen: 'timeline', viewport: V,
        check: 'полноэкранный просмотр картинок',
        detail: `открыт=${!!viewer}, поверх сайта=${viewer?.topLayer}, стрелок=${viewer?.navs}, картинка загружена=${viewer?.imgLoaded}, листание=${flip}, закрылся по Esc=${closed}`,
        where: 'components/ImageViewer.tsx / CopyPanel',
      })
    } else {
      pass('timeline', V, `просмотр картинок: ${viewer?.counter}, листание, Esc`)
    }
  }

  // 6. Фон кадра: тон (событию показанного кадра)
  await selectEditorRowForFrame(page)
  await page.click('.ed-bg .ed-chip:has-text("тон")')
  await page.waitForTimeout(300)
  await page.locator('.ed-tone').nth(2).click()
  await page.waitForTimeout(500)
  await gotoFrame(page, 1)
  const tone = (await page.evaluate(`!!document.querySelector('.sf-scene[data-active="true"] .sf-scene__tone')`)) as boolean
  if (!tone) {
    add({ severity: 'error', area: 'functional', screen: 'timeline', viewport: V, check: 'фон кадра «тон»', detail: 'тон не применён к кадру', where: 'BackgroundPicker / SceneFrame' })
  } else {
    pass('timeline', V, 'фон кадра «тон»')
  }

  // 7. Сохранение после перезагрузки
  await page.reload()
  await page.waitForSelector('.sf-root', { timeout: 25000 })
  await page.waitForTimeout(2200)
  const persisted = (await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.ed-row'))
    return { rows: rows.length, hasChapter: rows.some((r) => (r.textContent || '').includes('Глава аудита')) }
  })()`)) as { rows: number; hasChapter: boolean }
  if (!persisted.hasChapter || persisted.rows < 3) {
    add({ severity: 'error', area: 'functional', screen: 'persistence', viewport: V, check: 'сохранение после перезагрузки', detail: JSON.stringify(persisted), where: 'yprovider snapshot/CRDT' })
  } else {
    pass('persistence', V, `после перезагрузки строк ${persisted.rows}`)
  }

  // 8. Тема переключается и запоминается
  const before = (await page.evaluate(`document.documentElement.dataset.theme || 'dark'`)) as string
  await page.click('button[aria-label="Переключить тему"]')
  await page.waitForTimeout(900)
  const after = (await page.evaluate(`document.documentElement.dataset.theme || 'dark'`)) as string
  await page.reload()
  await page.waitForTimeout(1200)
  const restored = (await page.evaluate(`document.documentElement.dataset.theme || 'dark'`)) as string
  if (before === after || restored !== after) {
    add({ severity: 'error', area: 'functional', screen: 'theme', viewport: V, check: 'темы', detail: `${before} → ${after}, после reload ${restored}`, where: 'store/theme.ts' })
  } else {
    pass('theme', V, `тема ${after} сохраняется`)
  }
  await setTheme(page, 'dark', false)

  // 9. Приглашение с ролью viewer: пишет ли viewer
  const token = await apiLogin()
  const invitedEmail = `audit.viewer.${Date.now()}@e.com`
  const inviteRes = await fetch(`${BASE}/api/projects/${projectId}/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email: invitedEmail, role: 'viewer' }),
  })
  const invite = (await inviteRes.json()) as { token?: string }
  if (!invite.token) {
    add({ severity: 'error', area: 'functional', screen: 'teams', viewport: V, check: 'приглашение', detail: `не создалось (${inviteRes.status})`, where: 'teams.Invite' })
  } else {
    pass('teams', V, 'приглашение создано')
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page2 = await ctx2.newPage()
    // Пользователя создаём так, как это возможно на этой инсталляции
    // (в режиме «по заявке» — заявкой с одобрением администратором),
    // и входим через интерфейс: проверяем приглашение, а не форму регистрации.
    const viewerCreated = await ensureTestUser(invitedEmail, 'Audit Viewer')
    if (!viewerCreated.ok) {
      add({ severity: 'error', area: 'functional', screen: 'teams', viewport: V, check: 'создание приглашённого пользователя', detail: viewerCreated.note, where: 'auth register / admin approve' })
    }
    await login(page2, invitedEmail, 'hunter22!')
    await page2.waitForTimeout(1200)

    // Приглашение принимаем через сам интерфейс (/invitations/:token)
    await page2.goto(`${BASE}/invitations/${invite.token}`)
    let accepted = false
    for (let i = 0; i < 20; i++) {
      await page2.waitForTimeout(500)
      const url = page2.url()
      const text = (await page2.evaluate(`document.body.innerText`)) as string
      if (url.includes(`/projects/${projectId}`) || text.includes('Приглашение принято')) {
        accepted = true
        break
      }
    }
    if (!accepted) {
      add({ severity: 'error', area: 'functional', screen: 'teams', viewport: V, check: 'принятие приглашения', detail: `страница /invitations не приняла приглашение (url ${page2.url()})`, where: 'AcceptInvitation.tsx / teams.Accept' })
    } else {
      pass('teams', V, 'приглашение принято через интерфейс')
      const viewerWrite = await page2.evaluate(
        `(async () => {
          const raw = window.localStorage.getItem('skyfraze-auth')
          const token = raw ? (JSON.parse(raw).state || {}).accessToken : null
          const res = await fetch('/api/projects/${projectId}/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
            body: JSON.stringify({ title: 'viewer hack' }),
          })
          return res.status
        })()`,
      )
      if (viewerWrite !== 403) {
        add({ severity: 'error', area: 'functional', screen: 'teams', viewport: V, check: 'viewer не должен писать', detail: `POST /events → ${viewerWrite}`, where: 'events.Service.RequireEditor' })
      } else {
        pass('teams', V, 'viewer получает 403 на запись')
      }
    }
    await ctx2.close()
  }

  // 10. Realtime CRDT: вторая вкладка видит правку
  const peer = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const peerPage = await peer.newPage()
  await login(peerPage)
  await peerPage.goto(`${BASE}/projects/${projectId}`)
  await peerPage.waitForSelector('.sf-root', { timeout: 25000 })
  await peerPage.waitForTimeout(2200)
  await page.evaluate(() => {
    document.querySelector('[data-editor-panel]')?.scrollIntoView({ behavior: 'instant', block: 'start' })
  })
  await page.waitForTimeout(600)
  const marker = `realtime ${Date.now()}`
  await page.fill('.ed-form input[placeholder="Заголовок события"]', marker)
  let seen = false
  for (let i = 0; i < 20; i++) {
    await peerPage.waitForTimeout(500)
    seen = (await peerPage.evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`)) as boolean
    if (seen) break
  }
  if (!seen) {
    add({ severity: 'error', area: 'functional', screen: 'realtime', viewport: V, check: 'realtime CRDT', detail: 'вторая вкладка не увидела правку за 10 c', where: 'collab hub / yprovider' })
  } else {
    pass('realtime', V, 'вторая вкладка увидела правку')
  }
  await peer.close()

  // 11. Публичная лента: только опубликованное, просмотр без правок, оценки
  const publicSlug = await ensurePublicStory()
  if (!publicSlug) {
    add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'публичная лента', detail: 'нет публичной истории: проверь POST /publication и GET /api/public/feed', where: 'feed.Service / SetPublication' })
  } else {
    const feedRes = await fetch(`${BASE}/api/public/feed`)
    const feedJson = (await feedRes.json()) as { items: Array<{ slug: string; author: string; views: number }> }
    const card = feedJson.items.find((i) => i.slug === publicSlug)
    if (!card) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'лента отдаёт опубликованное', detail: `истории ${publicSlug} нет в ленте (${feedJson.items.length} шт.)`, where: 'store.ListPublicFeed' })
    } else {
      pass('feed', V, `лента: «${card.author}», просмотров ${card.views}`)
    }

    // Публичная страница анонимом: история видна, элементов правки нет.
    const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
    const anon = await anonCtx.newPage()
    await anon.goto(`${BASE}/s/${publicSlug}`)
    const stageOk = await anon
      .waitForSelector('.sf-track', { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    if (!stageOk) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'публичная история без входа', detail: 'стадия не открылась анонимом', where: 'PublicStoryPage / public/stories' })
    } else {
      const view = (await anon.evaluate(`(() => ({
        editors: !!document.querySelector('[data-editor-panel], .ed-panel'),
        stars: document.querySelectorAll('.pub-rating__star').length,
        editButtons: Array.from(document.querySelectorAll('button'))
          .filter((b) => /опубликовать|снять с публикации|удалить|участник|редактор/i.test(b.textContent || '')).length,
      }))()`)) as { editors: boolean; stars: number; editButtons: number }
      if (view.editors || view.editButtons > 0) {
        add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'публичная страница только для чтения', detail: `редакторы=${view.editors}, кнопок правки=${view.editButtons}`, where: 'PublicStoryPage (не должно быть EditorsPanel)' })
      } else {
        pass('feed', V, 'публичная страница без элементов правки')
      }
      if (view.stars !== 5) {
        add({ severity: 'warning', area: 'functional', screen: 'feed', viewport: V, check: 'оценка видна анониму', detail: `звёзд ${view.stars}`, where: 'RatingStars' })
      } else {
        pass('feed', V, 'оценки видны анониму (5 звёзд)')
      }
    }
    await anonCtx.close()

    // Правила оценок через API: аноним не может, автор не может, чужой может.
    const anonRate = await fetch(`${BASE}/api/public/stories/${publicSlug}/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stars: 5 }),
    })
    if (anonRate.status !== 401) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'аноним не оценивает', detail: `POST rating → ${anonRate.status}, ожидалось 401`, where: 'feed handler WithUser' })
    } else {
      pass('feed', V, 'аноним на оценку получает 401')
    }

    const ownerToken = await apiLogin()
    const selfRate = await fetch(`${BASE}/api/public/stories/${publicSlug}/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ stars: 5 }),
    })
    if (selfRate.status !== 403) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'автор не оценивает свою историю', detail: `POST rating владельцем → ${selfRate.status}, ожидалось 403`, where: 'feed.Service.Rate (ErrSelfRating)' })
    } else {
      pass('feed', V, 'автору отказано в самооценке (403)')
    }

    const readerEmail = `audit.reader.${Date.now()}@e.com`
    const readerCreated = await ensureTestUser(readerEmail, 'Audit Reader')
    const readerLogin = readerCreated.ok
      ? await fetch(`${BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: readerEmail, password: 'hunter22!' }),
        })
      : null
    const readerToken = readerLogin?.ok
      ? ((await readerLogin.json()) as { tokens?: { access: string } }).tokens?.access
      : undefined
    if (!readerToken) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'оценка читателем', detail: `не удалось завести читателя (${readerCreated.note})`, where: 'auth register / admin approve' })
    } else {
      const rate = await fetch(`${BASE}/api/public/stories/${publicSlug}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readerToken}` },
        body: JSON.stringify({ stars: 4 }),
      })
      const rated = (await rate.json()) as { rating_avg: number; rating_count: number; my_rating: number }
      if (rate.status !== 200 || rated.my_rating !== 4 || rated.rating_count < 1) {
        add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'оценка читателем', detail: `статус ${rate.status}, ответ ${JSON.stringify(rated)}`, where: 'store.UpsertRating' })
      } else {
        pass('feed', V, `оценка учтена: ${rated.rating_avg} ★ (${rated.rating_count})`)
      }
      const bad = await fetch(`${BASE}/api/public/stories/${publicSlug}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readerToken}` },
        body: JSON.stringify({ stars: 9 }),
      })
      if (bad.status !== 400) {
        add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'звёзды 1..5', detail: `stars=9 → ${bad.status}, ожидалось 400`, where: 'feed.Service.Rate (ErrBadRating)' })
      } else {
        pass('feed', V, 'некорректная оценка отклоняется (400)')
      }
      // Убираем голос за собой: аудит не должен оставлять оценки в ленте.
      await fetch(`${BASE}/api/public/stories/${publicSlug}/rating`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${readerToken}` },
      })
    }

    // Просмотры: повторный заход тем же браузером не накручивает счётчик.
    // Считаем по интерфейсу, а не через fetch: серверный fetch без cookie —
    // это каждый раз «новый посетитель», и такая проверка ловила бы саму себя.
    const repeatCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
    const repeatPage = await repeatCtx.newPage()
    await repeatPage.goto(`${BASE}/s/${publicSlug}`)
    const viewsReady = await repeatPage
      .waitForSelector('.pub-meta__views', { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
    if (!viewsReady) {
      add({ severity: 'warning', area: 'functional', screen: 'feed', viewport: V, check: 'счётчик просмотров виден', detail: 'на публичной странице нет .pub-meta__views', where: 'PublicStoryPage copyFooter' })
    } else {
      const views1 = (await repeatPage.locator('.pub-meta__views').innerText()).trim()
      await repeatPage.reload()
      await repeatPage.waitForSelector('.pub-meta__views', { timeout: 20000 }).catch(() => null)
      await repeatPage.waitForTimeout(900)
      const views2 = (await repeatPage.locator('.pub-meta__views').innerText()).trim()
      if (views1 !== views2) {
        add({ severity: 'warning', area: 'functional', screen: 'feed', viewport: V, check: 'просмотры дедуплицируются', detail: `«${views1}» → «${views2}» за два захода одним браузером`, where: 'project_views / cookie sf_vid' })
      } else {
        pass('feed', V, `просмотры не накручиваются (${views2})`)
      }
    }
    await repeatCtx.close()

    // Снятие с публикации закрывает историю, повторная — возвращает ту же ссылку.
    const unpublish = await fetch(`${BASE}/api/projects/${DEMO.split('/').filter(Boolean).pop()}/publication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ is_public: false }),
    })
    const closed = await fetch(`${BASE}/api/public/stories/${publicSlug}`)
    const feedEmpty = ((await (await fetch(`${BASE}/api/public/feed`)).json()) as { items: Array<{ slug: string }> }).items
      .every((i) => i.slug !== publicSlug)
    if (unpublish.status !== 200 || closed.status !== 404 || !feedEmpty) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'снятие с публикации', detail: `publication=${unpublish.status}, story=${closed.status}, скрыт из ленты=${feedEmpty}`, where: 'store.SetPublication / is_public' })
    } else {
      pass('feed', V, 'снятая история скрыта из ленты и по ссылке (404)')
    }
    const republish = await fetch(`${BASE}/api/projects/${DEMO.split('/').filter(Boolean).pop()}/publication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ is_public: true }),
    })
    const again = (await republish.json()) as { public_slug?: string }
    if (again.public_slug !== publicSlug) {
      add({ severity: 'error', area: 'functional', screen: 'feed', viewport: V, check: 'ссылка не меняется', detail: `${publicSlug} → ${again.public_slug}`, where: 'feed.Service.SetPublication' })
    } else {
      pass('feed', V, 'повторная публикация сохраняет ссылку')
    }
  }

  // 12. Администрирование: режим регистрации и заявки на доступ
  const adminToken = await apiLogin()
  const adminAuthHeaders = { Authorization: `Bearer ${adminToken}` }

  const configRes = await fetch(`${BASE}/api/auth/config`)
  const config = (await configRes.json()) as { registration_mode?: string }
  if (config.registration_mode === 'request' || config.registration_mode === 'open') {
    pass('admin', V, `режим регистрации: ${config.registration_mode}`)
  } else {
    add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'режим регистрации', detail: `GET /api/auth/config → ${JSON.stringify(config)}`, where: 'auth.Handler.Config / app_settings' })
  }

  const adminRes = await fetch(`${BASE}/api/admin/settings`, { headers: adminAuthHeaders })
  if (!adminRes.ok) {
    add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'админка доступна администратору', detail: `GET /api/admin/settings → ${adminRes.status}`, where: 'ADMIN_EMAILS / admin.RequireAdmin' })
  } else {
    const s = (await adminRes.json()) as { registration_mode: string; admins: number; pending_requests: number }
    pass('admin', V, `настройки: админов ${s.admins}, режим ${s.registration_mode}, заявок ${s.pending_requests}`)
  }

  const auditEmail = `audit.admin.${Date.now()}@e.com`
  const requestRes = await fetch(`${BASE}/api/auth/registration-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: auditEmail, password: 'hunter22!', display_name: 'Audit Applicant', message: 'проверка аудита' }),
  })
  if (requestRes.status !== 202) {
    add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'заявка на доступ', detail: `POST /registration-requests → ${requestRes.status}`, where: 'auth.SubmitRegistrationRequest' })
  } else {
    pass('admin', V, 'заявка на доступ принята (202)')

    // До решения администратора входа нет — и это объяснимо (403, не 401).
    const early = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: auditEmail, password: 'hunter22!' }),
    })
    if (early.status !== 403) {
      add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'вход до одобрения', detail: `login → ${early.status}, ожидалось 403`, where: 'auth.Service.Login / ErrRequestPending' })
    } else {
      pass('admin', V, 'вход до одобрения запрещён (403)')
    }

    const listRes = await fetch(`${BASE}/api/admin/registrations?status=pending`, { headers: adminAuthHeaders })
    const list = (await listRes.json()) as { requests: Array<{ id: string; email: string }> }
    const created = list.requests.find((r) => r.email === auditEmail)
    if (!created) {
      add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'заявка видна администратору', detail: `в списке ${list.requests.length} заявок, нужной нет`, where: 'store.ListRegistrationRequests' })
    } else {
      const approveRes = await fetch(`${BASE}/api/admin/registrations/${created.id}/approve`, {
        method: 'POST',
        headers: adminAuthHeaders,
      })
      if (!approveRes.ok) {
        add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'одобрение заявки', detail: `approve → ${approveRes.status}`, where: 'admin.Service.Approve' })
      } else {
        // Одобренный пользователь — как раз «обычный»: на нём и проверяем,
        // что в админку ему нельзя.
        const after = await fetch(`${BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: auditEmail, password: 'hunter22!' }),
        })
        const body = after.ok ? ((await after.json()) as { tokens?: { access: string } }) : null
        if (!body?.tokens?.access) {
          add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'вход после одобрения', detail: `login → ${after.status}`, where: 'admin.Service.Approve / auth.Login' })
        } else {
          pass('admin', V, 'одобренная заявка даёт вход тем же паролем')
          const denied = await fetch(`${BASE}/api/admin/settings`, {
            headers: { Authorization: `Bearer ${body.tokens.access}` },
          })
          if (denied.status !== 403) {
            add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'админка закрыта обычному пользователю', detail: `GET /api/admin/settings → ${denied.status}, ожидалось 403`, where: 'admin.RequireAdmin' })
          } else {
            pass('admin', V, 'обычный пользователь получает 403')
          }
        }
      }
    }
  }

  // Переключение режима: open разрешает прямую регистрацию, request — закрывает.
  const toOpen = await fetch(`${BASE}/api/admin/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminAuthHeaders },
    body: JSON.stringify({ registration_mode: 'open' }),
  })
  const freeReg = toOpen.ok
    ? await fetch(`${BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `audit.free.${Date.now()}@e.com`, password: 'hunter22!', display_name: 'Audit Free' }),
      })
    : null
  await fetch(`${BASE}/api/admin/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...adminAuthHeaders },
    body: JSON.stringify({ registration_mode: 'request' }),
  })
  const backToRequest = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `audit.closed.${Date.now()}@e.com`, password: 'hunter22!', display_name: 'Audit Closed' }),
  })
  if (!toOpen.ok || !freeReg?.ok || backToRequest.status !== 403) {
    add({ severity: 'error', area: 'functional', screen: 'admin', viewport: V, check: 'переключение режима регистрации', detail: `open=${toOpen.status}, register=${freeReg?.status}, назад в request=${backToRequest.status}`, where: 'admin.SetRegistrationMode / auth.Register' })
  } else {
    pass('admin', V, 'режим переключается: open пускает, request закрывает')
  }

  // 13. Перенос проекта: экспорт архива и защита от повторного импорта
  const exportRes = await fetch(`${BASE}/api/projects/${projectId}/export`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const zipBytes = exportRes.ok ? new Uint8Array(await exportRes.arrayBuffer()) : new Uint8Array()
  // ZIP всегда начинается с сигнатуры PK (50 4B): так отличаем архив от JSON-ошибки.
  const looksLikeZip = zipBytes.length > 4 && zipBytes[0] === 0x50 && zipBytes[1] === 0x4b
  if (!exportRes.ok || !looksLikeZip) {
    add({ severity: 'error', area: 'functional', screen: 'transfer', viewport: V, check: 'экспорт проекта', detail: `статус ${exportRes.status}, ${zipBytes.length} байт, zip=${looksLikeZip}`, where: 'transfer.Handler.Export' })
  } else {
    pass('transfer', V, `экспорт: архив ${Math.round(zipBytes.length / 1024)} КБ`)
  }

  // Тот же архив, загруженный в ту же базу, где проект ещё существует, обязан
  // получить 409: молча «перезаписать» проект нельзя.
  const importForm = new FormData()
  importForm.append('file', new Blob([zipBytes], { type: 'application/zip' }), 'audit.skyfraze.zip')
  const importRes = await fetch(`${BASE}/api/projects/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: importForm,
  })
  if (importRes.status !== 409) {
    add({ severity: 'error', area: 'functional', screen: 'transfer', viewport: V, check: 'повторный импорт архива', detail: `статус ${importRes.status}, ожидалось 409`, where: 'transfer.ErrAlreadyImported' })
  } else {
    pass('transfer', V, 'повторный импорт архива отклонён (409)')
  }

  // очистка
  const del = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
  if (del.status !== 204) {
    add({ severity: 'warning', area: 'functional', screen: 'cleanup', viewport: V, check: 'удаление тестового проекта', detail: `статус ${del.status}`, where: '—' })
  }
  await ctx.close()
}

// ─────────────────────────────────────────────────────────── отчёт

function report(errors: string[]) {
  fs.mkdirSync(OUT, { recursive: true })
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity])
  const errorsFound = sorted.filter((f) => f.severity === 'error')
  const warnings = sorted.filter((f) => f.severity === 'warning')
  const passed = sorted.filter((f) => f.severity === 'info')

  const lines: string[] = []
  lines.push('# Визуальный и функциональный аудит SkyFraze')
  lines.push('')
  lines.push(`Дата: ${new Date().toISOString()}`)
  lines.push(`Стенд: ${BASE}`)
  lines.push('')
  lines.push(`- ошибок: **${errorsFound.length}**`)
  lines.push(`- предупреждений: **${warnings.length}**`)
  lines.push(`- успешных проверок: ${passed.length}`)
  lines.push(`- ошибок консоли/сети: ${errors.length}`)
  lines.push('')
  lines.push('## Ошибки')
  lines.push('')
  lines.push('| экран | вьюпорт | проверка | деталь | где править | скрин |')
  lines.push('|---|---|---|---|---|---|')
  for (const f of errorsFound) {
    lines.push(`| ${f.screen} | ${f.viewport} | ${f.check} | ${f.detail.replace(/\|/g, '/')} | ${f.where} | ${f.shot ?? '—'} |`)
  }
  lines.push('')
  lines.push('## Предупреждения')
  lines.push('')
  lines.push('| экран | вьюпорт | проверка | деталь | где править |')
  lines.push('|---|---|---|---|---|')
  for (const f of warnings) {
    lines.push(`| ${f.screen} | ${f.viewport} | ${f.check} | ${f.detail.replace(/\|/g, '/')} | ${f.where} |`)
  }
  lines.push('')
  lines.push('## Успешные проверки')
  lines.push('')
  for (const f of passed) lines.push(`- ${f.screen}/${f.viewport}: ${f.check} — ${f.detail}`)
  if (errors.length > 0) {
    lines.push('')
    lines.push('## Консоль/сеть')
    lines.push('')
    for (const e of errors.slice(0, 40)) lines.push(`- ${e}`)
  }
  fs.writeFileSync(path.join(OUT, 'visual-report.md'), lines.join('\n'), 'utf8')
  fs.writeFileSync(
    path.join(OUT, 'visual-report.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, findings: sorted, consoleErrors: errors, shots }, null, 2),
    'utf8',
  )
  console.log(`\n=== ИТОГ: ошибок ${errorsFound.length}, предупреждений ${warnings.length}, ок ${passed.length}, консоль ${errors.length} ===`)
  for (const f of errorsFound.slice(0, 15)) console.log(`  ERROR  [${f.screen}/${f.viewport}] ${f.check}: ${f.detail}`)
  for (const f of warnings.slice(0, 10)) console.log(`  WARN   [${f.screen}/${f.viewport}] ${f.check}: ${f.detail}`)
  console.log(`отчёт: ${path.join(OUT, 'visual-report.md')}`)
  return errorsFound.length
}

async function main() {
  const { chromium } = await loadPlaywright()
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const consoleErrors: string[] = []

  if (!ONLY_FUNCTIONAL) {
    console.log('--- визуальная часть ---')
    const publicSlug = await ensurePublicStory()
    if (!publicSlug) {
      console.log('[visual] публичная история недоступна: демо-проект не опубликован')
    }
    await visualScreens(browser, consoleErrors, publicSlug)
    await visualPublic(browser, consoleErrors, publicSlug)
  }
  if (!ONLY_SCREENS) {
    console.log('--- функциональная часть ---')
    await functional(browser, consoleErrors)
  }
  await browser.close()
  const errorsFound = report(consoleErrors)
  process.exit(errorsFound > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
