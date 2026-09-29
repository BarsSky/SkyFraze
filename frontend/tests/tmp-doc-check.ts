// Проверка мобильного документа: кадры идут друг за другом, скролл один общий.
// Временный скрипт.
import { chromium } from 'playwright'
import * as fs from 'fs'

const BASE = process.env.REMOTE_URL ?? 'http://localhost'
const SLUG = process.env.STORY_SLUG ?? 'galactic-story-0aefdb2c'
const OUT = 'C:/Projects/_doc_check'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const problems: string[] = []
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? ' — ' + detail : ''}`)
  if (!cond) problems.push(label)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 120)) })
await page.addInitScript(() => window.localStorage.setItem('skyfraze-theme', 'light'))
await page.goto(`${BASE}/s/${SLUG}`)
await page.waitForSelector('.sf-root', { timeout: 30000 })
await page.waitForTimeout(2500)

const doc = (await page.evaluate(`(() => {
  const root = document.querySelector('.sf-root')
  const blocks = Array.from(document.querySelectorAll('[data-doc-frame]'))
  const body = document.querySelector('.sf-doc__event .sf-copy__body')
  const main = document.querySelector('.layout main')
  return {
    mode: root?.getAttribute('data-stage'),
    blocks: blocks.map((b) => b.getAttribute('data-frame-kind')),
    numbers: blocks.map((b) => b.getAttribute('data-frame-number')),
    hasStage: !!document.querySelector('.sf-stage'),
    hasTrack: !!document.querySelector('.sf-track'),
    hasCopyLayer: !!document.querySelector('.sf-copylayer'),
    bodyOverflow: body ? getComputedStyle(body).overflowY : null,
    bodyScrolls: body ? body.scrollHeight > body.clientHeight + 1 : null,
    mainScrollable: main ? main.scrollHeight > main.clientHeight + 1 : null,
    docScrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }
})()`)) as Record<string, any>
console.log('документ:', JSON.stringify(doc))
ok('включён режим документа', doc.mode === 'document', String(doc.mode))
ok('фиксированной сцены нет', doc.hasStage === false && doc.hasTrack === false && doc.hasCopyLayer === false)
ok('кадры идут по порядку: текст события → его картинки', (() => {
  const kinds = doc.blocks as string[]
  const imageAt = kinds.map((k, i) => (k === 'image' ? i : -1)).filter((i) => i >= 0)
  return imageAt.length > 0 && imageAt.every((i) => kinds[i - 1] === 'event')
})(), String(doc.blocks.join(',')))
ok('у текста нет своей прокрутки', doc.bodyScrolls === false && doc.bodyOverflow !== 'auto', `${doc.bodyOverflow} scrolls=${doc.bodyScrolls}`)
ok('страница прокручивается целиком', doc.mainScrollable === true)
ok('нет горизонтального выезда', Number(doc.docScrollW) <= Number(doc.innerW) + 1, `${doc.docScrollW}/${doc.innerW}`)

// Скролл над текстом должен двигать документ, а не отдельное поле. Проверяем в
// обычном контексте (в мобильной эмуляции колесо мыши не доставляется), но с той
// же шириной — значит, тот же режим документа.
const wheelCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
const wheelPage = await wheelCtx.newPage()
await wheelPage.goto(`${BASE}/s/${SLUG}`)
await wheelPage.waitForSelector('.sf-doc__event', { timeout: 30000 })
await wheelPage.waitForTimeout(1200)
const box = await wheelPage.locator('.sf-doc__event .sf-copy__body').first().boundingBox()
const before = (await wheelPage.evaluate(`document.querySelector('.layout main').scrollTop`)) as number
if (box) {
  await wheelPage.mouse.move(box.x + box.width / 2, Math.min(box.y + 30, 700))
  await wheelPage.mouse.wheel(0, 400)
  await wheelPage.waitForTimeout(600)
}
const after = (await wheelPage.evaluate(`document.querySelector('.layout main').scrollTop`)) as number
console.log(`скролл: было ${before}, стало ${after}`)
ok('скролл над текстом двигает страницу', after > before)
await wheelCtx.close()
await page.screenshot({ path: `${OUT}/doc-top.png` })

// Переключатель событий остаётся на виду и ведёт к нужной главе.
const chipsSticky = (await page.evaluate(`(() => {
  const chips = document.querySelector('.sf-doc__chips')
  if (!chips) return null
  const r = chips.getBoundingClientRect()
  return { top: Math.round(r.top), position: getComputedStyle(chips).position, visible: r.top >= -1 && r.bottom <= window.innerHeight }
})()`)) as Record<string, unknown> | null
console.log('чипы:', JSON.stringify(chipsSticky))
ok('переключатель событий липнет и виден', chipsSticky?.position === 'sticky' && chipsSticky?.visible === true, JSON.stringify(chipsSticky))

const images = (await page.evaluate(`(() => {
  const imgs = Array.from(document.querySelectorAll('.sf-doc__image img'))
  return { count: imgs.length, loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length }
})()`)) as Record<string, number>
console.log('картинки:', JSON.stringify(images))
ok('картинки идут отдельными блоками и загружены', images.count >= 1 && images.loaded === images.count, JSON.stringify(images))

await page.evaluate(`(() => { const m = document.querySelector('.layout main'); if (m) m.scrollTop = m.scrollHeight })()`)
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/doc-bottom.png` })
ok('нет ошибок в консоли', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(`\nошибок: ${problems.length}`)
process.exit(problems.length ? 1 : 0)
