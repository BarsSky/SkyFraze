import { test, expect, type Page } from '@playwright/test'
import { signIn, gateAssistant, openProjectTab } from './support'

/**
 * Выделение фрагмента в показе проекта (0.132.0) — целиком через браузер.
 *
 * Ради чего написан: фича живёт на стыке трёх мест страницы (стадия → плавающее окно → редакторы),
 * и юнит-тесты проверяют каждое звено по отдельности, а связку «выделил → меню → ушло туда, куда
 * нажали» видит только браузер.
 *
 * Выделение — настоящее, двойным щелчком: Chromium выделяет слово и сам шлёт `selectionchange`,
 * поэтому проверяется тот же путь, что у человека. Цитату берём из `window.getSelection()`, а не
 * угадываем: текст кадра пишет заглушка модели, и знать его заранее нельзя.
 */
test.setTimeout(240_000)

/** Проект с главой «Пролог»: её создаёт заглушка помощника, как в соседних сценариях. */
async function projectWithChapter(page: Page): Promise<void> {
  const title = `Выделение ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'выделение фрагмента')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })
  await page.locator('[data-assistant-fab]').click()
}

/** Текст кадра в показе: по нему считаем, что вообще можно выделить. */
async function stageBody(page: Page) {
  const body = page.locator('[data-frame-body]').first()
  await expect(body).toBeVisible({ timeout: 45_000 })
  await expect
    .poll(async () => (await body.innerText()).trim().length, { timeout: 45_000 })
    .toBeGreaterThan(10)
  return body
}

/** Сколько участков подсвечено в показе (CSS Custom Highlight API, 0.133.0). */
const highlightSize = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights
    return registry?.get('sf-quote')?.size ?? 0
  })

/**
 * Выделить слово в тексте кадра двойным щелчком и дождаться меню.
 *
 * Координаты считаем по самому слову, а не по центру абзаца: абзац во всю ширину колонки, и
 * двойной щелчок по его середине попадает в пустое место справа от короткой строки — тогда
 * выделяется перевод строки, а не слово (именно так этот сценарий и упал в первый раз).
 *
 * Возвращает выделенную цитату: её подставляет само меню, и по ней дальше проверяем, что ушло
 * именно то, что человек выделил.
 */
async function selectWord(page: Page): Promise<string> {
  const body = await stageBody(page)
  const word = await body.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text !== null) {
      const found = /\p{L}{5,}/u.exec(text.data)
      if (found) {
        const range = document.createRange()
        range.setStart(text, found.index + 1)
        range.setEnd(text, found.index + 2)
        const rect = range.getBoundingClientRect()
        // Только слово, которое человек видит: лист кадра бывает выше окна, и выделять то, что
        // за кромкой, человек не станет — он туда и не нажмёт.
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top > 70 &&
          rect.bottom < window.innerHeight - 20
        if (visible) {
          return {
            word: found[0],
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }
        }
      }
      text = walker.nextNode() as Text | null
    }
    return null
  })
  expect(word, 'в тексте кадра должно найтись слово от пяти букв').not.toBeNull()

  await page.mouse.dblclick(word!.x, word!.y)
  const menu = page.locator('[data-selection-menu]')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  const quote = (await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim()
  expect(quote.length, 'двойной щелчок должен выделить слово').toBeGreaterThan(3)
  expect(word!.word).toContain(quote.replace(/[^\p{L}-]/gu, ''))
  return quote
}

test('выделил фрагмент: чат проекта, помощник, быстрая правка и переход в редакторы', async ({
  page,
}) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await projectWithChapter(page)

  // Стадия: глава показана в режиме «Проект».
  await openProjectTab(page, 'project')
  const quote = await selectWord(page)

  // 1. В чат проекта: окно открывается на вкладке чата, поле заполнено цитатой со ссылкой на кадр,
  //    но НЕ отправлено — человек дописывает мысль сам.
  await page.locator('[data-selection-chat]').click()
  const panel = page.locator('[data-assistant-panel]')
  const chat = panel.locator('[data-project-chat]')
  await expect(chat).toBeVisible({ timeout: 20_000 })
  const chatInput = chat.getByLabel('Сообщение в чат проекта')
  await expect(chatInput).toHaveValue(new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await expect(chatInput).toHaveValue(/Пролог/)
  await page.locator('[data-assistant-fab]').click()

  // 2. Помощнику: та же цитата, но во вкладке помощника — и снова без автоотправки.
  await selectWord(page)
  await page.locator('[data-selection-assistant]').click()
  const assistantInput = await (async () => {
    await expect(page.locator('[data-dock-tab="assistant"]')).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    })
    const field = page.locator('[data-assistant-panel]').getByLabel('Сообщение помощнику')
    await expect(field).toBeVisible({ timeout: 20_000 })
    return field
  })()
  await expect(assistantInput).toHaveValue(new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await page.locator('[data-assistant-fab]').click()

  // 3. Быстрая правка: окно показывает ровно выделенный кусок и сохраняет правку в текст кадра.
  await selectWord(page)
  await page.locator('[data-selection-edit]').click()
  const window_ = page.locator('[data-quick-edit]')
  await expect(window_).toBeVisible({ timeout: 20_000 })
  const field = window_.locator('[data-quick-edit-field]')
  await expect(field).toHaveValue(quote)
  const edited = `Правка-${Date.now()}`
  await field.fill(edited)
  await window_.locator('[data-quick-edit-save]').click()
  await expect(window_.locator('[data-quick-edit-note]')).toContainText('сохранён', { timeout: 20_000 })
  await window_.getByRole('button', { name: 'Отмена' }).click()
  // Правка видна в показе: она ушла в текст проекта, а не в окно.
  await expect(page.locator('[data-frame-body]').first()).toContainText(edited, { timeout: 30_000 })

  // 4. Переход в редакторы на тот же фрагмент: открывается вкладка редакторов с этим кадром, и
  //    поле текста приходит с выделенным куском — «показывает строчку, где».
  await selectWord(page)
  await page.locator('[data-selection-edit]').click()
  await expect(page.locator('[data-quick-edit]')).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-quick-edit-editors]').click()
  await expect(page.locator('[data-project-tab="editors"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000,
  })
  const editorsBody = page.locator('.ed-form textarea').first()
  await expect(editorsBody).toHaveValue(new RegExp(edited), { timeout: 45_000 })
  // Выделение в поле текста — то самое место, а не начало кадра.
  const selected = await editorsBody.evaluate((node: HTMLTextAreaElement) =>
    node.value.slice(node.selectionStart, node.selectionEnd),
  )
  expect(selected.length).toBeGreaterThan(0)
  expect(edited).toContain(selected)

  // 5. Обратный переход «из редакторов в проект» (0.133.0): кнопка «Показать в проекте» открывает
  //    показ на этом кадре и подсвечивает выделенный кусок.
  //
  //    Выделение — настоящее, клавиатурой: редактор узнаёт о нём из `select`/`keyup`, а
  //    программный `setSelectionRange` (так поле пришло из показа, шаг 4) этих событий не шлёт.
  //    Идём посимвольно до слова: словесное выделение браузера останавливается на границах,
  //    которые зависят от переносов кадра.
  const target = await editorsBody.evaluate((node: HTMLTextAreaElement) => {
    const word = /\p{L}{5,}/u.exec(node.value)
    return word ? { word: word[0], index: word.index, length: word[0].length } : null
  })
  expect(target, 'в тексте кадра должно найтись слово от пяти букв').not.toBeNull()
  await editorsBody.click()
  await page.keyboard.press('Control+Home')
  for (let step = 0; step < target!.index; step += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.down('Shift')
  for (let step = 0; step < target!.length; step += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  const editorQuote = (
    await editorsBody.evaluate((node: HTMLTextAreaElement) =>
      node.value.slice(node.selectionStart, node.selectionEnd),
    )
  ).trim()
  expect(editorQuote).toBe(target!.word)
  // Редактор знает о выделении: кнопка «замечание к фрагменту» появляется только при нём.
  await expect(page.locator('[data-select-fragment]')).toBeVisible({ timeout: 15_000 })
  await page.locator('[data-show-in-project]').click()
  await expect(page.locator('[data-project-tab="project"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000,
  })
  await expect(page.locator('[data-frame-body]').first()).toContainText(editorQuote, {
    timeout: 30_000,
  })
  await expect.poll(() => highlightSize(page), { timeout: 20_000 }).toBeGreaterThan(0)

  // 6. «Строчка в проекте» у получателя ссылки из чата (0.133.0): выделили → отправили в чат →
  //    нажали ссылку на кадр → показ встал на кадр и подсветил ту же фразу.
  await openProjectTab(page, 'project')
  const linked = await selectWord(page)
  await page.locator('[data-selection-chat]').click()
  const chatPane = page.locator('[data-project-chat]')
  await expect(chatPane).toBeVisible({ timeout: 20_000 })
  await chatPane.getByRole('button', { name: 'Отправить' }).click()
  const messageLink = chatPane.locator('[data-chat-link]').last()
  await expect(messageLink).toContainText(linked, { timeout: 30_000 })
  await messageLink.click()
  // Окно закрываем, чтобы видеть показ: сама подсветка живёт в реестре браузера и от окна не
  // зависит, но проверять её «за окном» — значит проверять не то, что видит человек.
  await page.locator('[data-assistant-fab]').click()
  await expect(page.locator('[data-project-tab="project"]')).toHaveAttribute('aria-selected', 'true', {
    timeout: 30_000,
  })
  await expect(page.locator('[data-frame-body]').first()).toContainText(linked, { timeout: 30_000 })
  await expect.poll(() => highlightSize(page), { timeout: 20_000 }).toBeGreaterThan(0)
})
