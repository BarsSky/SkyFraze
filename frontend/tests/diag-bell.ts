/**
 * Точечная проверка панели колокольчика на телефоне (0.98.1).
 *
 * Наблюдение из `diag-mobile-taps.ts`: после тапа по колокольчику `aria-expanded` становится true,
 * а сама панель имеет высоту ~18 px и пустой текст — то есть «кнопка нажалась, а ничего не
 * произошло», ровно как в отчёте. Здесь смотрим, чем панель задавлена: вычисленные стили, размеры,
 * что лежит сверху.
 *
 * Запуск: cd frontend && npx tsx tests/diag-bell.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })

  const bell = page.locator('[data-notify-bell]').first()
  await bell.tap()
  await page.waitForTimeout(400)

  const report = (await page.evaluate(`(async () => {
    const panel = document.querySelector('[data-notify-panel]')
    if (!panel) return { found: false }
    const box = panel.getBoundingClientRect()
    const style = getComputedStyle(panel)
    const parent = panel.parentElement
    const parentStyle = parent ? getComputedStyle(parent) : null
    const parentBox = parent ? parent.getBoundingClientRect() : null
    return {
      found: true,
      box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      style: {
        display: style.display,
        visibility: style.visibility,
        position: style.position,
        overflow: style.overflow,
        maxHeight: style.maxHeight,
        zIndex: style.zIndex,
        whiteSpace: style.whiteSpace,
        fontSize: style.fontSize,
        padding: style.padding,
        borderWidth: style.borderWidth,
        background: style.backgroundColor,
        boxShadow: style.boxShadow === 'none' ? 'нет' : 'есть',
        top: style.top,
        left: style.left,
        right: style.right,
      },
      html: panel.innerHTML.slice(0, 240),
      childCount: panel.children.length,
      // Панелей может быть больше одной (разные варианты разметки) — берём все.
      allPanels: [...document.querySelectorAll('[data-notify-panel]')].map((node) => {
        const box = node.getBoundingClientRect()
        return {
          cls: node.className,
          box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          text: (node.innerText || '').slice(0, 40),
        }
      }),
      children: [...panel.children].map((node) => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          tag: node.tagName.toLowerCase(),
          cls: node.className,
          box: { h: Math.round(box.height), w: Math.round(box.width) },
          margin: style.margin,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          display: style.display,
        }
      }),
      parent: parent
        ? {
            cls: parent.className,
            box: { w: Math.round(parentBox.width), h: Math.round(parentBox.height) },
            display: parentStyle.display,
            overflow: parentStyle.overflow,
            position: parentStyle.position,
          }
        : null,
    }
  })()`)) as Record<string, unknown>
  console.log(JSON.stringify(report, null, 2))

  await page.screenshot({ path: '..\\_dev_shots\\bell-panel.png' })
  await context.close()
  await browser.close()
}

await main()
