// Разовая проверка «своих серверов моделей» в настройке помощника НА ЖИВОМ стенде.
//
// Зачем отдельным скриптом. Юнит-тесты панели подменяют сеть целиком, то есть проверяют
// поведение, а не то, что человек действительно увидит поля. Здесь же браузер ходит по
// настоящему API: добавляет сервер через форму, видит его в списке, удаляет — и всё это
// на двух ширинах, потому что на телефоне список с длинными адресами ломается первым.
//
//   npx tsx tests/own-server-check.ts [baseUrl]
//
// ВНИМАНИЕ: скрипт меняет данные стенда (добавляет и удаляет свой сервер у тестового
// пользователя). Адрес сервера моделей можно задать через OWN_SERVER_URL.

import { chromium } from 'playwright'

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost'
const EMAIL = 'galactic.test@e.com'
const PASSWORD = 'hunter22!'
const OWN_URL = process.env.OWN_SERVER_URL ?? 'http://localhost:18080/v1'
const TITLE = `Проверка формы ${Date.now() % 100000}`

const VIEWPORTS = [
  { width: 1280, height: 900, tag: 'desktop' },
  { width: 390, height: 844, tag: 'mobile' },
]

const browser = await chromium.launch()
let failed = false

/** Открыть настройку помощника в первом проекте пользователя. */
async function openSettings(page: import('playwright').Page) {
  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20_000 })
  await page.locator('a[href^="/projects/"]').first().click()
  // Панель проекта: ждём кнопку помощника, иначе клик уйдёт в пустоту.
  await page.waitForSelector('[data-assistant-fab]', { timeout: 20_000 })
  await page.click('[data-assistant-fab]')
  await page.waitForSelector('[data-assistant-panel]', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Настройка помощника' }).click()
  await page.waitForSelector('[data-assistant-endpoints]', { timeout: 20_000 })
}

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  const consoleErrors: string[] = []
  const badResponses: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  // Ошибка в консоли браузера не говорит, КУДА ходили: без адреса и кода непонятно, наш
  // это запрос или чужой (например, картинка проекта). Собираем адреса отдельно.
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`)
  })

  await openSettings(page)
  console.log(`\n=== ${vp.tag} ${vp.width}×${vp.height} ===`)

  // 1. Поля на месте и их видно — это и был исходный дефект: вводить адрес было негде.
  // Внутри evaluate нельзя присваивать стрелки переменным: esbuild добавляет им имена
  // (`__name`), а в браузере этой функции нет — проверка падала бы на ровном месте.
  const fields = await page.evaluate(() => {
    const block = document.querySelector('[data-assistant-endpoints]')
    if (!block) return null
    const box = block.getBoundingClientRect()
    const inputs = ['Название своего сервера', 'Адрес своего сервера', 'Ключ своего сервера'].map(
      (label) => {
        const el = block.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          label,
          width: Math.round(r.width),
          height: Math.round(r.height),
          disabled: el.disabled,
        }
      },
    )
    return {
      visible: box.width > 0 && box.height > 0,
      inputs,
      local: block.querySelector('input[aria-label="Сервер считает на моей машине"]') !== null,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    }
  })
  if (fields === null) {
    console.log('  ❌ блок «Свои серверы моделей» не найден')
    failed = true
    await ctx.close()
    continue
  }
  const title = fields.inputs[0]
  const url = fields.inputs[1]
  const key = fields.inputs[2]
  const missing = fields.inputs.filter((item) => item === null).length
  if (missing > 0) {
    console.log(`  ❌ не нашлось полей: ${missing} из 3`)
    failed = true
  } else {
    console.log(
      `  ✔ поля: название ${title!.width}×${title!.height}, адрес ${url!.width}×${url!.height}, ключ ${key!.width}×${key!.height}${key!.disabled ? ' (выключен)' : ''}`,
    )
    for (const f of [title!, url!, key!]) {
      if (!f.disabled && f.width < 120) {
        console.log(`  ❌ поле «${f.label}» уже ${f.width}px — адрес в такое не влезает`)
        failed = true
      }
    }
  }
  if (!fields.local) {
    console.log('  ❌ нет галочки «считает на моей машине»: от неё зависит согласие')
    failed = true
  }

  const before = await page.locator('[data-assistant-endpoints-list] li').count()
  console.log(`  своих серверов до: ${before}`)

  // 2. Добавляем через форму — так, как это делает человек.
  await page.getByLabel('Название своего сервера').fill(TITLE)
  await page.getByLabel('Адрес своего сервера').fill(OWN_URL)
  await page.getByRole('button', { name: 'Добавить сервер' }).click()
  await page.waitForSelector(`text=Сервер «${TITLE}» добавлен`, { timeout: 30_000 })
  const after = await page.locator('[data-assistant-endpoints-list] li').count()
  console.log(`  ✔ добавлен через форму, серверов стало: ${after}`)
  if (after !== before + 1) {
    console.log('  ❌ список не вырос на один сервер')
    failed = true
  }

  // 3. Он же появился в списке провайдеров — и выбран: иначе человек не поймёт, что
  //    сервер подключился.
  const provider = await page.evaluate(() => {
    const select = document.querySelector('.ai-field select') as HTMLSelectElement | null
    if (!select) return null
    const chosen = select.options[select.selectedIndex]?.textContent ?? ''
    return {
      chosen,
      hasOwn: Array.from(select.options).some((o) => o.textContent?.includes('Проверка формы')),
    }
  })
  if (provider === null || !provider.hasOwn) {
    console.log('  ❌ добавленного сервера нет в списке провайдеров')
    failed = true
  } else {
    console.log(`  ✔ в списке провайдеров есть; выбран: «${provider.chosen.trim()}»`)
  }

  // 4. Адрес виден в списке и не растягивает документ: длинная строка — обычная причина
  //    горизонтального скролла на телефоне.
  const overflow = fields.docScrollWidth > fields.docClientWidth
  console.log(
    `  документ: ${fields.docScrollWidth} против ${fields.docClientWidth} → ${overflow ? 'ЕСТЬ горизонтальный скролл' : 'по ширине влезает'}`,
  )
  if (overflow) {
    console.log('  ❌ настройка расширяет документ')
    failed = true
  }

  await page.screenshot({ path: `tests/.own-server-${vp.tag}.png`, fullPage: false })

  // 5. Удаляем — через ту же кнопку, что и человек.
  await page.getByRole('button', { name: `Удалить сервер ${TITLE}` }).click()
  await page.waitForSelector(`text=Сервер «${TITLE}» удалён`, { timeout: 30_000 })
  const removed = await page.locator('[data-assistant-endpoints-list] li').count()
  console.log(`  ✔ удалён через форму, серверов стало: ${removed}`)
  if (removed !== before) {
    console.log(`  ❌ после удаления серверов ${removed}, ожидалось ${before}`)
    failed = true
  }

  if (consoleErrors.length > 0) {
    console.log(`  ❌ ошибки в консоли: ${consoleErrors.slice(0, 3).join(' | ')}`)
    failed = true
  } else {
    console.log('  ✔ ошибок в консоли нет')
  }
  if (badResponses.length > 0) {
    console.log(`  ⚠ ответы с ошибкой: ${badResponses.slice(0, 5).join(' | ')}`)
  }

  await ctx.close()
}

await browser.close()
console.log(failed ? '\nИТОГ: есть дефекты' : '\nИТОГ: свои серверы работают через интерфейс')
process.exit(failed ? 1 : 0)
