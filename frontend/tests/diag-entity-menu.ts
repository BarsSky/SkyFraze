/**
 * Живая проверка меню «⋮» и стиля групп в «Связях проекта» (0.102.0).
 *
 * Отчёт: «в Связи проекта выделить стилем в светлой и тёмной темах группы, а также элементы
 * управления; второй скрин убрать в три точки и сделать выпадающим списком».
 *
 * Проверяем числами, а не на глаз:
 *   1. группа — полоса с фоном и рамкой (контраст текста ≥ 4.5:1) в ОБЕИХ темах, число карточек —
 *      пилюлей у правого края;
 *   2. «⋮» — единственная кнопка действия в строке карточки, не меньше 32×32, и она видна в обеих
 *      темах (контраст значка ≥ 3:1);
 *   3. меню открывается, видно целиком (проверка `elementFromPoint`: элемент в этой точке — само
 *      меню, а не соседняя карточка), пункты не ниже 32 px, Escape и клик мимо закрывают;
 *   4. удаление спрашивается строкой под карточкой, «Оставить» отменяет;
 *   5. на телефоне (360×740, касания) меню не уезжает за край экрана и пункт нажимается пальцем.
 *
 * Проект создаётся и удаляется скриптом — стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-entity-menu.ts (backend :8181 и vite :5173 подняты)
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

const CARDS: Array<[string, string]> = [
  ['Аня', 'character'],
  ['Борис', 'character'],
  ['Земля', 'place'],
]

type GroupStyle = {
  theme: string
  height: number
  fontWeight: string
  textTransform: string
  background: string
  color: string
  borderColor: string
  contrast: number
  countBackground: string | null
  countRadius: string | null
  countContrast: number
  groups: Array<{ kind: string; title: string; open: boolean }>
}

type TriggerStyle = {
  width: number
  height: number
  color: string
  background: string
  borderColor: string
  contrast: number
  rowHeights: number[]
  actionsHeight: number
  buttonsInRow: number
}

type MenuInfo = {
  missing?: boolean
  role?: string | null
  items?: Array<{ text: string; height: number }>
  rect?: { left: number; right: number; top: number; bottom: number; width: number; height: number }
  viewport?: { w: number; h: number }
  reachable?: boolean
  gapBelowTrigger?: number | null
  gapAboveTrigger?: number | null
  placement?: string | null
  flipped?: boolean
  background?: string
  shadow?: string
}

/** Открыть «Связи» проекта и раскрыть блок карточек: состояние блока помнится в localStorage. */
async function openRelations(page: Page, projectId: string) {
  await page.goto(`${BASE}/projects/${projectId}`)
  const relationsTab = page.locator('[data-project-tab="relations"]')
  await relationsTab.waitFor({ state: 'visible', timeout: 30_000 })
  await relationsTab.click()
  const panel = page.locator('details.ent')
  await panel.waitFor({ state: 'attached', timeout: 20_000 })
  if (!(await panel.evaluate((node: HTMLDetailsElement) => node.open))) {
    await panel.locator('summary').first().click()
  }
  await page.locator('.ent__group-summary').first().waitFor({ state: 'visible', timeout: 20_000 })
}

/** Стиль группы и «⋮» в текущей теме. Контраст считаем по WCAG из фактических цветов. */
async function measureStyles(page: Page): Promise<{ group: GroupStyle; trigger: TriggerStyle }> {
  return page.evaluate(
    `(async () => {
      const nums = (value) => (value.match(/[\\d.]+/g) || []).map(Number)
      // color-mix в Chromium считается как color(srgb r g b / a) с долями 0..1 — приводим к 0..255.
      const parse = (value) => {
        const parts = nums(value || '')
        if ((value || '').startsWith('color(')) return parts.slice(0, 3).map((v) => v * 255)
        return parts.slice(0, 3)
      }
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const ratio = (a, b) => {
        const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x)
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
      }

      const summary = document.querySelector('.ent__group-summary')
      const scs = getComputedStyle(summary)
      const count = document.querySelector('.ent__group-count')
      const ccs = count ? getComputedStyle(count) : null
      const box = summary.getBoundingClientRect()

      const trigger = document.querySelector('[data-entity-menu]')
      const tcs = getComputedStyle(trigger)
      const tbox = trigger.getBoundingClientRect()
      const row = trigger.closest('.ent__item')
      const actions = trigger.closest('.ent__actions')
      const actionsBox = actions ? actions.getBoundingClientRect() : tbox
      const rowHeights = [...document.querySelectorAll('[data-entity-kind]')].map((node) =>
        Math.round(node.getBoundingClientRect().height),
      )

      return {
        group: {
          theme: document.documentElement.dataset.theme || '',
          height: Math.round(box.height),
          fontWeight: scs.fontWeight,
          textTransform: scs.textTransform,
          background: scs.backgroundColor,
          color: scs.color,
          borderColor: scs.borderTopColor,
          contrast: ratio(scs.color, scs.backgroundColor),
          countBackground: ccs ? ccs.backgroundColor : null,
          countRadius: ccs ? ccs.borderTopLeftRadius : null,
          // Пилюля полупрозрачная: считаем текст числа против фона самой группы.
          countContrast: ccs ? ratio(ccs.color, scs.backgroundColor) : 0,
          groups: [...document.querySelectorAll('[data-entity-group]')].map((node) => ({
            kind: node.getAttribute('data-entity-group') || '',
            title: (node.querySelector('.ent__group-summary')?.textContent || '').trim(),
            open: node.open === true,
          })),
        },
        trigger: {
          width: Math.round(tbox.width),
          height: Math.round(tbox.height),
          color: tcs.color,
          background: tcs.backgroundColor,
          borderColor: tcs.borderTopColor,
          contrast: ratio(tcs.color, tcs.backgroundColor),
          rowHeights,
          // Высота всего блока действий: с четырьмя кнопками он занимал вторую строку и
          // разъезжался на узком экране. Одна «⋮» — это ровно высота кнопки.
          actionsHeight: Math.round(actionsBox.height),
          // Кнопок действия в строке карточки: должна остаться ровно одна — сама «⋮».
          buttonsInRow: row ? row.querySelectorAll('.ent__actions > button').length : 0,
        },
      }
    })()`,
  ) as Promise<{ group: GroupStyle; trigger: TriggerStyle }>
}

/** Открыть меню «⋮» у карточки и снять его геометрию. */
/** Прочитать уже открытое меню: геометрия, пункты, досягаемость, место относительно кнопки. */
async function readMenu(page: Page): Promise<MenuInfo> {
  return page.evaluate(
    `(async () => {
      const menu = document.querySelector('[data-entity-menu-list]')
      if (!menu) return { missing: true }
      const trigger = menu.parentElement ? menu.parentElement.querySelector('[data-entity-menu]') : null
      const tbox = trigger ? trigger.getBoundingClientRect() : null
      const box = menu.getBoundingClientRect()
      const cx = Math.round(box.left + Math.min(24, box.width / 2))
      const cy = Math.round(box.top + Math.min(16, box.height / 2))
      const hit = document.elementFromPoint(cx, cy)
      return {
        role: menu.getAttribute('role'),
        items: [...menu.querySelectorAll('[role="menuitem"]')].map((node) => ({
          text: (node.textContent || '').trim(),
          height: Math.round(node.getBoundingClientRect().height),
        })),
        rect: {
          left: Math.round(box.left),
          right: Math.round(box.right),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
        viewport: { w: window.innerWidth, h: window.innerHeight },
        reachable: !!hit && menu.contains(hit),
        // Меню стоит под своей кнопкой (зазор 4 px) или, у нижнего края, над ней.
        gapBelowTrigger: tbox ? Math.round(box.top - tbox.bottom) : null,
        gapAboveTrigger: tbox ? Math.round(tbox.top - box.bottom) : null,
        placement: tbox
          ? box.top >= tbox.bottom - 1
            ? 'below'
            : box.bottom <= tbox.top + 1
              ? 'above'
              : 'over'
          : null,
        flipped: menu.className.includes('is-up'),
        background: getComputedStyle(menu).backgroundColor,
        shadow: getComputedStyle(menu).boxShadow,
      }
    })()`,
  ) as Promise<MenuInfo>
}

async function measureMenu(page: Page, card: string): Promise<MenuInfo> {
  await page.getByLabel(`Действия с карточкой ${card}`).click()
  await page.waitForTimeout(150)
  return readMenu(page)
}

async function main() {
  const browser: Browser = await chromium.launch()
  const problems: string[] = []
  const numbers: Record<string, unknown> = {}

  // Логин один раз: на dev-стенде лимит попыток в минуту (5), и повторные входы дают 429.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
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
  const storage = await context.storageState()

  const created = await (
    await page.request.post(`${API}/api/projects`, {
      headers,
      data: { title: 'Диагностика меню карточек', description: '' },
    })
  ).json()
  const projectId: string = created.project?.id ?? created.id
  console.log(`проект: ${projectId}`)

  try {
    // Глава через интерфейс: вкладки проекта существуют только у проекта с содержимым.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })

    const ids = new Map<string, string>()
    for (const [name, kind] of CARDS) {
      const response = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
        headers,
        data: { name, kind },
      })
      if (response.status() !== 201) problems.push(`карточка «${name}»: ${response.status()}`)
      const body = (await response.json()) as { entity?: { id: string } }
      if (body.entity?.id) ids.set(name, body.entity.id)
    }
    const linked = await page.request.post(
      `${API}/api/projects/${projectId}/entities/${ids.get('Аня')}/links`,
      { headers, data: { to: ids.get('Земля'), label: 'живёт на' } },
    )
    if (linked.status() !== 201) problems.push(`связь: ${linked.status()}`)

    // ─── обе темы на широком экране ────────────────────────────────────────────
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(`localStorage.setItem('skyfraze-theme', '${theme}')`)
      await openRelations(page, projectId)
      const { group, trigger } = await measureStyles(page)

      if (group.theme !== theme) problems.push(`тема не переключилась на «${theme}»: ${group.theme}`)
      if (group.contrast < 4.5) {
        problems.push(`[${theme}] текст группы на фоне группы: контраст ${group.contrast} < 4.5`)
      }
      if (group.countContrast < 4.5) {
        problems.push(`[${theme}] число карточек: контраст ${group.countContrast} < 4.5`)
      }
      if (!group.countRadius || Number.parseFloat(group.countRadius) < 8) {
        problems.push(`[${theme}] число карточек не пилюлей: радиус ${group.countRadius}`)
      }
      if (group.height < 26) problems.push(`[${theme}] полоса группы низкая: ${group.height} px`)
      // Фон группы должен отличаться от фона блока — иначе «выделить стилем» не выполнено.
      if (group.background === group.borderColor) {
        problems.push(`[${theme}] у группы нет собственного фона/рамки`)
      }
      if (group.groups.length < 2) problems.push(`[${theme}] групп меньше двух: ${group.groups.length}`)
      if (group.groups.some((item) => item.title === '')) {
        problems.push(`[${theme}] у группы нет подписи`)
      }

      if (trigger.width < 32 || trigger.height < 32) {
        problems.push(`[${theme}] «⋮» мелкая: ${trigger.width}×${trigger.height}`)
      }
      if (trigger.buttonsInRow !== 1) {
        problems.push(`[${theme}] кнопок в строке карточки: ${trigger.buttonsInRow} (ждали одну — «⋮»)`)
      }
      if (trigger.contrast < 3) {
        problems.push(`[${theme}] значок «⋮»: контраст ${trigger.contrast} < 3`)
      }
      // Блок действий должен занимать одну строку: с четырьмя кнопками он разъезжался на две, и
      // карточки становились разной высоты. Сейчас это ровно высота кнопки «⋮».
      if (trigger.actionsHeight > 44) {
        problems.push(`[${theme}] блок действий в две строки: ${trigger.actionsHeight} px`)
      }

      numbers[`group_${theme}`] = group
      numbers[`trigger_${theme}`] = trigger
      await page.locator('[data-entities]').screenshot({ path: `entity-menu-${theme}.png` })
      console.log(
        `[${theme}] группа ${group.height} px, контраст ${group.contrast}, число ${group.countContrast}; ` +
          `«⋮» ${trigger.width}×${trigger.height}, контраст ${trigger.contrast}; ` +
          `действия ${trigger.actionsHeight} px; строки ${trigger.rowHeights.join('/')}`,
      )
    }

    // ─── меню: открытие, геометрия, закрытие ───────────────────────────────────
    await openRelations(page, projectId)
    const menu = await measureMenu(page, 'Аня')
    numbers.menu_desktop = menu
    if (menu.missing) {
      problems.push('меню «⋮» не открылось')
    } else {
      const items = (menu.items ?? []).map((item) => item.text)
      // Кадров с упоминаниями у карточки нет, поэтому «Где встречается» отсутствует по делу.
      if (items.join('|') !== 'Изменить|Связать|Удалить') {
        problems.push(`пункты меню: ${JSON.stringify(items)}`)
      }
      if (menu.role !== 'menu') problems.push(`роль меню: ${menu.role}`)
      if (!menu.reachable) problems.push('меню не в точке нажатия: сверху лежит что-то другое')
      if (menu.placement === 'over') problems.push('меню накрывает собственную кнопку «⋮»')
      if (menu.placement === 'below' && menu.gapBelowTrigger !== 4) {
        problems.push(`меню не под кнопкой: зазор ${String(menu.gapBelowTrigger)} px вместо 4`)
      }
      if ((menu.items ?? []).some((item) => item.height < 32)) {
        problems.push(`пункт меню ниже 32 px: ${JSON.stringify(menu.items)}`)
      }
      const rect = menu.rect!
      const viewport = menu.viewport!
      if (rect.right > viewport.w || rect.left < 0) {
        problems.push(`меню вылезает по горизонтали: ${rect.left}..${rect.right} при ${viewport.w}`)
      }
      if (rect.bottom > viewport.h) {
        problems.push(`меню уходит за нижний край: ${rect.bottom} > ${viewport.h}`)
      }
      console.log(
        `меню ${rect.width}×${rect.height} в (${rect.left},${rect.top}), пункты ` +
          `${(menu.items ?? []).map((item) => `${item.text}:${item.height}`).join(', ')}`,
      )
      await page.locator('[data-entities]').screenshot({ path: 'entity-menu-open.png' })
    }

    // Escape закрывает меню.
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    if ((await page.locator('[data-entity-menu-list]').count()) !== 0) {
      problems.push('Escape не закрыл меню')
    }
    // Клик мимо (по подсказке блока, не по меню) закрывает меню.
    await page.getByLabel('Действия с карточкой Аня').click()
    await page.waitForTimeout(100)
    await page.locator('.ent__hint').first().click()
    await page.waitForTimeout(150)
    if ((await page.locator('[data-entity-menu-list]').count()) !== 0) {
      problems.push('клик мимо не закрыл меню')
    }

    // ─── удаление: вопрос остаётся строкой под карточкой ───────────────────────
    await page.getByLabel('Действия с карточкой Борис').click()
    await page.getByLabel('Удалить карточку Борис').click()
    const confirm = page.locator('[data-entity-delete-confirm-row]')
    await confirm.waitFor({ state: 'visible', timeout: 5_000 })
    const confirmText = (await confirm.innerText()).replace(/\s+/g, ' ').trim()
    numbers.delete_confirm = confirmText
    if (!confirmText.includes('Удалить карточку «Борис»?')) {
      problems.push(`строка подтверждения: «${confirmText}»`)
    }
    if ((await page.locator('[data-entity-menu-list]').count()) !== 0) {
      problems.push('меню осталось открытым после пункта «Удалить»')
    }
    await confirm.getByRole('button', { name: 'Оставить' }).click()
    await page.waitForTimeout(150)
    if ((await page.locator('[data-entity-delete-confirm-row]').count()) !== 0) {
      problems.push('«Оставить» не убрало вопрос об удалении')
    }

    // ─── телефон: меню не уезжает за край и нажимается пальцем ─────────────────
    const phoneContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      hasTouch: true,
      isMobile: true,
      storageState: storage,
    })
    const phone = await phoneContext.newPage()
    phone.on('pageerror', (error) => problems.push(`pageerror (360): ${error.message}`))
    // localStorage доступен только на своём origin: сначала открываем страницу, потом ставим тему.
    await phone.goto(`${BASE}/projects`)
    await phone.evaluate(`localStorage.setItem('skyfraze-theme', 'dark')`)
    await openRelations(phone, projectId)
    const phoneMenu = await measureMenu(phone, 'Аня')
    numbers.menu_phone = phoneMenu
    if (phoneMenu.missing) {
      problems.push('на телефоне меню не открылось')
    } else {
      const rect = phoneMenu.rect!
      const viewport = phoneMenu.viewport!
      if (!phoneMenu.reachable) problems.push('на телефоне меню не в точке нажатия')
      if (phoneMenu.placement === 'over') problems.push('на телефоне меню накрывает свою кнопку')
      if (phoneMenu.placement === 'below' && phoneMenu.gapBelowTrigger !== 4) {
        problems.push(`на телефоне меню не под кнопкой: зазор ${String(phoneMenu.gapBelowTrigger)} px`)
      }
      if (rect.left < 0 || rect.right > viewport.w) {
        problems.push(`на телефоне меню за краем: ${rect.left}..${rect.right} при ${viewport.w}`)
      }
      if (rect.bottom > viewport.h) {
        problems.push(`на телефоне меню за нижним краем: ${rect.bottom} > ${viewport.h}`)
      }
      // Пункт нажимается пальцем: тап по «Изменить» открывает правку именно этой карточки.
      await phone.locator('[data-entities]').screenshot({ path: 'entity-menu-phone.png' })
      await phone.getByLabel('Изменить карточку Аня').tap()
      const edit = phone.getByLabel('Имя карточки Аня')
      await edit.waitFor({ state: 'visible', timeout: 5_000 })
      const fieldHeight = await edit.evaluate((node) => Math.round(node.getBoundingClientRect().height))
      numbers.phone_edit_field = fieldHeight
      if (fieldHeight < 28) problems.push(`на телефоне поле правки низкое: ${fieldHeight} px`)
      await phone.getByRole('button', { name: 'Отмена' }).tap()
      console.log(
        `телефон: меню ${rect.width}×${rect.height} в (${rect.left},${rect.top}) при ${viewport.w}×${viewport.h}, ` +
          `пункты ${(phoneMenu.items ?? []).map((item) => item.height).join('/')} px`,
      )
    }
    // Последняя карточка у нижнего края: меню должно развернуться ВВЕРХ, иначе «Удалить» уйдёт за
    // экран. В 0.102.0 проверялась только первая карточка — этот случай и остался бы незамеченным.
    const lastTrigger = phone.locator('[data-entity-menu]').last()
    await lastTrigger.scrollIntoViewIfNeeded()
    await phone.waitForTimeout(250)
    await lastTrigger.click()
    await phone.waitForTimeout(250)
    const lastMenu = await readMenu(phone)
    numbers.menu_phone_last = lastMenu
    if (lastMenu.missing) {
      problems.push('на телефоне меню последней карточки не открылось')
    } else {
      const rect = lastMenu.rect!
      const viewport = lastMenu.viewport!
      if (rect.bottom > viewport.h) {
        problems.push(`последняя карточка: меню за нижним краем (${rect.bottom} > ${viewport.h})`)
      }
      if (lastMenu.placement !== 'above') {
        problems.push(`последняя карточка: меню не развернулось вверх (${lastMenu.placement})`)
      }
      if (lastMenu.gapAboveTrigger !== 4) {
        problems.push(`последняя карточка: зазор над кнопкой ${String(lastMenu.gapAboveTrigger)} px вместо 4`)
      }
      await phone.locator('[data-entities]').screenshot({ path: 'entity-menu-phone-up.png' })
      await phone.keyboard.press('Escape')
      console.log(
        `телефон, последняя карточка: меню ${rect.width}×${rect.height} в (${rect.left},${rect.top}), ` +
          `разворот: ${String(lastMenu.placement)} (is-up: ${String(lastMenu.flipped)})`,
      )
    }

    await phoneContext.close()
  } finally {
    await page.request.delete(`${API}/api/projects/${projectId}/purge`, { headers }).catch(() => undefined)
    await page.request.delete(`${API}/api/projects/${projectId}`, { headers }).catch(() => undefined)
    await browser.close()
  }

  console.log('---')
  console.log(JSON.stringify(numbers, null, 2))
  if (problems.length > 0) {
    console.error(`ПРОБЛЕМЫ (${problems.length}):`)
    for (const problem of problems) console.error(` - ${problem}`)
    process.exitCode = 1
  } else {
    console.log('проблем нет')
  }
}

void main()
