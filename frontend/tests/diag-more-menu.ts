/**
 * Точечная проверка меню «Ещё» на телефоне (0.98.2).
 *
 * Отчёт: «колокольчик работал, а вот кнопка „Ещё“ не реагировала». Кнопка управляет состоянием
 * (`aria-expanded`), поэтому важно не «нажалась ли она», а **видно ли меню** и попадает ли в него
 * касание. Раньше проверка была слабой — `getBoundingClientRect().width > 0` возвращает размер и у
 * обрезанного, невидимого меню. Здесь смотрим: где меню, что лежит в его точке, какие предки его
 * обрезают (`overflow`) и влезает ли оно в видимую область.
 *
 * Запуск: cd frontend && npx tsx tests/diag-more-menu.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const WIDTHS = (process.env.WIDTHS ?? '320,360,390,412,430').split(',').map(Number)

async function main() {
  const browser = await chromium.launch()
  const problems: string[] = []

  // Входим ОДИН раз и переносим состояние в контексты ширин: у стенда ограничитель входа
  // (5 попыток в минуту на адрес), и диагональ по пяти ширинам упиралась в 429 — падало не то,
  // что проверяли.
  const loginContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const loginPage = await loginContext.newPage()
  await loginPage.goto(`${BASE}/login`)
  await loginPage.getByPlaceholder('email').fill(EMAIL)
  await loginPage.getByPlaceholder('пароль').fill(PASSWORD)
  await loginPage.getByRole('button', { name: /Войти/ }).click()
  await loginPage.waitForURL(/\/projects$/, { timeout: 20_000 })
  const storageState = await loginContext.storageState()
  await loginContext.close()

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      hasTouch: true,
      isMobile: true,
      storageState,
    })
    const page = await context.newPage()
    await page.goto(`${BASE}/projects`)
    await page.waitForURL(/\/projects$/, { timeout: 20_000 })

    const more = page.locator('[data-header-more]').first()
    const buttonBox = await more.boundingBox()
    await more.tap()
    await page.waitForTimeout(300)

    const report = (await page.evaluate(`(async () => {
      const round = (value) => Math.round(value)
      const button = document.querySelector('[data-header-more]')
      const menu = document.querySelector('[data-header-menu]')
      if (!button) return { button: null }
      const buttonBox = button.getBoundingClientRect()
      // Клипающие предки: у кого overflow не visible — тот и обрезает своим прямоугольником.
      const clippers = []
      let cursor = button.parentElement
      while (cursor && cursor !== document.body) {
        const style = getComputedStyle(cursor)
        if (style.overflow !== 'visible' && style.overflow !== '') {
          const box = cursor.getBoundingClientRect()
          clippers.push({
            cls: typeof cursor.className === 'string' ? cursor.className : cursor.tagName,
            overflow: style.overflow,
            box: { x: round(box.left), y: round(box.top), w: round(box.width), h: round(box.height) },
          })
        }
        cursor = cursor.parentElement
      }
      const menuBox = menu ? menu.getBoundingClientRect() : null
      // position: fixed не обрезается overflow предков — если только между ним и корнем нет
      // предка с transform/filter (он стал бы содержащим блоком). Проверяем это отдельно, иначе
      // проверка ругалась бы на обрезку, которой нет.
      let fixedEscapes = false
      if (menu) {
        const menuStyle = getComputedStyle(menu)
        if (menuStyle.position === 'fixed') {
          let transformed = false
          let parent = menu.parentElement
          while (parent && parent !== document.body) {
            const style = getComputedStyle(parent)
            if (style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none') {
              transformed = true
              break
            }
            parent = parent.parentElement
          }
          fixedEscapes = !transformed
        }
      }
      const itemCentre = menu && menu.firstElementChild ? menu.firstElementChild.getBoundingClientRect() : null
      const hitAtItem = itemCentre
        ? document.elementFromPoint(round(itemCentre.left + itemCentre.width / 2), round(itemCentre.top + itemCentre.height / 2))
        : null
      return {
        button: {
          box: { x: round(buttonBox.left), y: round(buttonBox.top), w: round(buttonBox.width), h: round(buttonBox.height) },
          expanded: button.getAttribute('aria-expanded'),
          // Влезает ли кнопка в свой контейнер: обрезанная кнопка — тоже «не нажимается».
          clipped: (() => {
            const parent = button.parentElement
            if (!parent) return false
            const pb = parent.getBoundingClientRect()
            return buttonBox.right > pb.right + 1 || buttonBox.left < pb.left - 1 || buttonBox.bottom > pb.bottom + 1
          })(),
        },
        menu: menuBox
          ? {
              box: { x: round(menuBox.left), y: round(menuBox.top), w: round(menuBox.width), h: round(menuBox.height) },
              items: menu.children.length,
              style: getComputedStyle(menu).position,
            }
          : null,
        itemHit: hitAtItem
          ? {
              tag: hitAtItem.tagName.toLowerCase(),
              cls: typeof hitAtItem.className === 'string' ? hitAtItem.className.slice(0, 40) : '',
              insideMenu: menu ? menu.contains(hitAtItem) : false,
            }
          : null,
        clippers,
        fixedEscapes,
      }
    })()`)) as {
      button: { box: { x: number; y: number; w: number; h: number }; expanded: string | null; clipped: boolean } | null
      menu: { box: { x: number; y: number; w: number; h: number }; items: number; style: string } | null
      itemHit: { tag: string; cls: string; insideMenu: boolean } | null
      fixedEscapes: boolean
      clippers: Array<{ cls: string; overflow: string; box: { x: number; y: number; w: number; h: number } }>
    }

    console.log(`\n=== ${width}px`)
    console.log(
      `кнопка «Ещё»: ${report.button?.box.w}×${report.button?.box.h} в (${report.button?.box.x}, ${report.button?.box.y}), ` +
        `aria-expanded ${report.button?.expanded}, обрезана ${report.button?.clipped}`,
    )
    if (report.menu === null) {
      console.log('меню: не отрисовано')
      problems.push(`${width}px: меню «Ещё» не отрисовалось после тапа`)
    } else {
      console.log(`меню: ${report.menu.box.w}×${report.menu.box.h} в (${report.menu.box.x}, ${report.menu.box.y}), пунктов ${report.menu.items}`)
      console.log(`в точке первого пункта: ${report.itemHit?.tag}.${report.itemHit?.cls} (внутри меню: ${report.itemHit?.insideMenu})`)
      if (report.itemHit === null || report.itemHit.insideMenu !== true) {
        problems.push(`${width}px: пункт меню не получает касание — в точке лежит «${report.itemHit?.tag}.${report.itemHit?.cls}»`)
      }
    }
    for (const clipper of report.clippers) {
      const menu = report.menu
      const cutsMenu =
        menu !== null &&
        report.fixedEscapes !== true &&
        (menu.box.y + menu.box.h > clipper.box.y + clipper.box.h + 1 ||
          menu.box.x + menu.box.w > clipper.box.x + clipper.box.w + 1)
      console.log(
        `обрезает: .${clipper.cls} (overflow: ${clipper.overflow}) ${clipper.box.w}×${clipper.box.h}` +
          (report.fixedEscapes ? ' — не страшно: меню fixed' : '') +
          (cutsMenu ? ' — меню не влезает' : ''),
      )
      if (cutsMenu) problems.push(`${width}px: меню обрезано контейнером .${clipper.cls} (overflow: ${clipper.overflow})`)
    }
    await page.screenshot({ path: `..\\_dev_shots\\more-menu-${width}.png` })
    await context.close()
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('\nпроблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('\nпроблемы: нет')
}

await main()
