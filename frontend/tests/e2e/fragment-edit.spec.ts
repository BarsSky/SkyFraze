import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab } from './support'

/**
 * Правка ФРАГМЕНТА по замечанию — целиком через браузер (0.104.0).
 *
 * Закрывает последнее «частично» из `docs/fragment-comments.md` §8 (фаза 5). Серверная часть
 * (якоря, `ReplaceEventSpan`, проверка «фрагмент не изменился») проверена интеграционными тестами
 * с 0.60–0.62, а вот что видит человек, не проверял никто: появляется ли диff «было → станет»,
 * применяется ли правка по кнопке, возвращается ли прежний фрагмент и что происходит, если
 * человек успел поправить этот же абзац до подтверждения.
 *
 * Кадр создаёт заглушка провайдера (как в соседних сценариях), замечание к фрагменту ставится
 * выделением в поле кадра, а ответ модели детерминирован: на слово «фрагмент» заглушка делает
 * тот же двухшаговый обмен, что и живая модель — `read_comments`, затем `propose_fragment_edit`.
 */
test.setTimeout(180_000)

/** Новый проект с одной главой «Пролог» (её создаёт заглушка помощника). */
async function projectWithFrame(page: import('@playwright/test').Page): Promise<void> {
  const title = `Фрагмент ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  if (await panel.getByText('Помощник выключен на этом стенде').isVisible().catch(() => false)) {
    test.skip(true, 'помощник выключен на стенде')
  }
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 45_000,
  })
  // Окно помощника перекрывает панель редакторов — закрываем, как в comments.spec.ts.
  await page.locator('[data-assistant-close]').click()
}

/**
 * Замечание к выделенному фрагменту. Выделение — настоящее, клавиатурой: React-овский onSelect
 * слушает нативные события, синтетический `select` его не будит (см. comments.spec.ts §4.2).
 */
async function commentOnFragment(page: import('@playwright/test').Page, text: string): Promise<string> {
  const body = page.locator('.ed-form textarea').first()
  await body.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.down('Shift')
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  await page.locator('[data-select-fragment]').click()
  const pending = page.locator('[data-frame-anchor-pending]')
  await expect(pending).toBeVisible()
  // Цитату берём из самого элемента, а не из `textContent` блока: в блоке ещё подпись
  // «замечание к фрагменту:» и кнопка «×», и такая строка в тексте кадра, конечно, не встречается.
  const quote = ((await pending.locator('.fc__pending-quote').innerText()) ?? '')
    .trim()
    .replace(/^«/, '')
    .replace(/»$/, '')

  await page.getByLabel('Новый комментарий').fill(text)
  await page.getByRole('button', { name: 'Написать' }).click()
  await expect(page.locator('[data-frame-comments]')).toContainText(text, { timeout: 30_000 })
  // Якорь живой: замечание привязано к тексту, а не к «пятому символу пятой строки».
  await expect(page.locator('[data-frame-comments] [data-frame-anchor="ok"]').first()).toBeVisible()
  return quote
}

/** Просьба исправить фрагмент: заглушка отвечает read_comments → propose_fragment_edit. */
async function askToFixFragment(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Исправь фрагмент по замечанию из обсуждения')
  await panel.getByRole('button', { name: 'Спросить' }).click()
}

test('правка фрагмента по замечанию: предложение, применение и возврат', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await projectWithFrame(page)

  const before = (await page.locator('.ed-form textarea').first().inputValue()).trim()
  const quote = await commentOnFragment(page, 'К этому куску замечание.')
  expect(quote.length).toBeGreaterThan(0)
  expect(before).toContain(quote)

  await askToFixFragment(page)

  // Предложение видно как диff «было → станет», и проект ещё НЕ изменён: применяет человек.
  const proposals = page.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })
  const diff = proposals.locator('[data-proposal-span]')
  await expect(diff).toBeVisible()
  await expect(diff).toContainText('Заменённый фрагмент текста.')
  await expect(page.locator('.ed-form textarea').first()).toHaveValue(before)

  await proposals.getByRole('button', { name: 'Применить' }).click()
  // Текст кадра изменился: старый кусок ушёл, новый встал на его место.
  await expect(page.locator('.ed-form textarea').first()).toHaveValue(
    new RegExp(`Заменённый фрагмент текста\\.`),
    { timeout: 45_000 },
  )
  const afterApply = await page.locator('.ed-form textarea').first().inputValue()
  expect(afterApply).not.toContain(quote)
  expect(afterApply.replace('Заменённый фрагмент текста.', '')).toBe(
    before.replace(quote, ''),
  )

  // «Вернуть прежний фрагмент» — кнопка именно про фрагмент, а не про кадр целиком.
  const applied = page.locator('[data-assistant-applied]')
  await expect(applied).toBeVisible({ timeout: 45_000 })
  await applied.getByRole('button', { name: 'Вернуть прежний фрагмент' }).click()
  await expect(page.locator('.ed-form textarea').first()).toHaveValue(before, { timeout: 45_000 })
})

test('человек правил фрагмент — предложение не применяется и говорит об этом', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await projectWithFrame(page)

  const before = (await page.locator('.ed-form textarea').first().inputValue()).trim()
  const quote = await commentOnFragment(page, 'Замечание к абзацу, который сейчас поправят.')
  expect(quote.length).toBeGreaterThan(0)

  await askToFixFragment(page)
  const proposals = page.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })

  // Человек правит САМ фрагмент, пока предложение ждёт подтверждения: именно этот случай
  // проверка «фрагмент не изменился» и должна поймать.
  const body = page.locator('.ed-form textarea').first()
  await body.click()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 2; i += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.type('Я')
  const edited = await body.inputValue()
  expect(edited).not.toBe(before)

  await proposals.getByRole('button', { name: 'Применить' }).click()
  // Отказ словами, а не тихое «применилось куда-то»: человек должен увидеть причину.
  const note = page.locator('[data-assistant-proposal-note]')
  await expect(note).toBeVisible({ timeout: 30_000 })
  await expect(note).toContainText('устарел')
  // Проект не тронут: правка человека на месте, предложенная замена не появилась.
  await expect(body).toHaveValue(edited)
  expect(await body.inputValue()).not.toContain('Заменённый фрагмент текста.')
})
