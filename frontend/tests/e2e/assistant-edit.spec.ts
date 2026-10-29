import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab, gateAssistant } from './support'

/**
 * Правка существующего кадра по подтверждению — целиком через браузер.
 *
 * Что проверяем и почему это нужно отдельным сценарием. Интеграционные тесты Go
 * доказывают, что проект не меняется до подтверждения, а применение доезжает до
 * документа. Но они не проверяют, что человек ВИДИТ предложение, что кнопка
 * «Применить» действительно его применяет и что новый текст появляется в редакторе
 * без перезагрузки. Это разные вещи: сервер мог сработать, а блок остаться пустым
 * (так и было с версиями — сервер отдавал `revision`, а клиент ждал `version`).
 *
 * Провайдер — заглушка `stub-ollama.mjs`. На просьбу со словом «перепиши» она отдаёт
 * вызов `update_event_text` для первого кадра из дерева в системном сообщении — ровно
 * так, как это сделала бы настоящая модель.
 */
test.setTimeout(180_000)

test('агент предлагает правку, а применяет её человек', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Правка ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  // 1. Сначала нужен кадр: без него предлагать переписать нечего.
  const fab = page.locator('[data-assistant-fab]')
  await fab.click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'правка кадра по подтверждению')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 30_000,
  })

  // 2. Просим переписать — агент должен ПРЕДЛОЖИТЬ, а не сделать.
  await input.fill('Перепиши главу короче')
  await panel.getByRole('button', { name: 'Спросить' }).click()

  const proposals = panel.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })
  await expect(proposals).toContainText('Переписать кадр «Пролог»')
  // Главное: это предложение, а не изменение. Блока «Изменения в проекте» быть не должно.
  await expect(panel.locator('[data-assistant-changes]')).toHaveCount(0)
  // И текст в кадре пока прежний.
  await expect(page.getByText('Так начинается история.').first()).toBeAttached()

  // 3. Применяем — теперь проект меняется.
  await proposals.getByRole('button', { name: 'Применить' }).click()
  await expect(panel.locator('[data-assistant-applied]')).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('[data-assistant-applied]')).toContainText('Переписан кадр «Пролог»')
  await expect(panel.locator('[data-assistant-proposal-note]')).toContainText('Текст изменён')

  // 4. Правка доехала до документа: новый текст виден в проекте без перезагрузки,
  //    а старый исчез.
  await expect(page.getByText('Переписанный текст кадра.').first()).toBeAttached({
    timeout: 30_000,
  })
  await expect(page.getByText('Так начинается история.')).toHaveCount(0)

  // 5. «Вернуть» возвращает прежний текст — и это тоже видно в проекте.
  await panel.locator('[data-assistant-applied]').getByRole('button', { name: 'Вернуть прежний текст' }).click()
  await expect(panel.locator('[data-assistant-proposals]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Так начинается история.').first()).toBeAttached({ timeout: 30_000 })
})

/**
 * Удаление кадра агентом — и его отмена.
 *
 * Отдельный сценарий, потому что удаление устроено иначе, чем перезапись: кадра после
 * применения физически нет ни в документе, ни в дереве, и «Вернуть» возвращает его
 * вставкой по снимку с прежним идентификатором и местом. Интеграционные тесты проверяют
 * это на уровне сервиса; здесь важно, что человек видит исчезновение кадра, кнопку
 * «Вернуть кадр» и возвращение строки в дерево — без перезагрузки страницы.
 */
test('удалённый агентом кадр можно вернуть', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Удаление ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'правка кадра по подтверждению')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })
  const chapterRow = page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()
  // 0.83.0: дерево кадров живёт на вкладке «Редакторы».
  await openEditorsTab(page)
  await expect(chapterRow).toBeVisible({ timeout: 45_000 })

  // 1. Агент удаление ПРЕДЛАГАЕТ: кадр на месте, дерево прежнее.
  await input.fill('Удали главу «Пролог», она лишняя')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  const proposals = panel.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })
  await expect(proposals).toContainText('Удалить кадр «Пролог»')
  await expect(chapterRow).toBeVisible()

  // 2. Применяем — кадр исчезает из дерева.
  await proposals.getByRole('button', { name: 'Применить' }).click()
  const applied = panel.locator('[data-assistant-applied]')
  await expect(applied).toBeVisible({ timeout: 30_000 })
  await expect(applied).toContainText('Удалён кадр «Пролог»')
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' })).toHaveCount(0, {
    timeout: 30_000,
  })

  // 3. «Вернуть кадр» возвращает его — с прежним заголовком и на прежнее место.
  await applied.getByRole('button', { name: 'Вернуть кадр' }).click()
  await expect(panel.locator('[data-assistant-proposals]')).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('[data-assistant-proposal-note]')).toContainText(
    'Кадр вернулся на прежнее место.',
    { timeout: 30_000 },
  )
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 30_000,
  })
})

/**
 * Отклонение предложения ничего не меняет в проекте.
 *
 * Отдельный сценарий, потому что «отклонить» — это не «применить и передумать»: сервер
 * вообще не трогает документ, и текст должен остаться прежним.
 */
test('отклонённое предложение не меняет текст кадра', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Отклонение ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()

  await page.locator('[data-assistant-fab]').click()
  const panel = page.locator('[data-assistant-panel]')
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'правка кадра по подтверждению')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })
  // Строку дерева ждём ДО проверок текста: редактор рисует кадр не мгновенно, а
  // проверка текста без этой опоры падала на медленном раннере.
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 45_000,
  })

  await input.fill('Перепиши главу короче')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  const proposals = panel.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })

  await proposals.getByRole('button', { name: 'Отклонить' }).click()
  await expect(panel.locator('[data-assistant-proposal-note]')).toContainText('проект не изменился', {
    timeout: 30_000,
  })
  await expect(panel.locator('[data-assistant-proposals]')).toHaveCount(0)
  // Текст кадра прежний.
  await expect(page.getByText('Так начинается история.').first()).toBeAttached({
    timeout: 30_000,
  })
})
