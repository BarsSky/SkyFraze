import { test, expect } from '@playwright/test'
import { signIn } from './support'

/**
 * Обсуждение кадра — целиком через браузер.
 *
 * Зачем отдельный сценарий. Компонентные тесты проверяют блок с подставленным API, а
 * серверные — ручки вызовами. Между ними остаётся ровно то, что ломалось раньше в других
 * фичах: блок не отрисовался, поле и кнопка не связаны, счётчик в дереве не появился,
 * комментарий не пережил перезагрузку. Это и проверяется здесь.
 *
 * Кадр создаёт заглушка провайдера: «Пролог» с текстом — как в соседних сценариях.
 */
test.setTimeout(180_000)

test('замечание к кадру пишется, видно в дереве и удаляется', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Обсуждение ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  // 1. Кадр: без него нечего обсуждать.
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
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 45_000,
  })
  // Окно помощника перекрывает панель редакторов — закрываем.
  await page.locator('[data-assistant-close]').click()

  // 2. Блок обсуждения под выбранным кадром: сначала пусто.
  const comments = page.locator('[data-frame-comments]')
  await expect(comments).toBeVisible({ timeout: 15_000 })
  await expect(comments).toContainText('пока пусто')

  // 3. Пишем замечание — оно появляется в блоке и счётчиком в дереве.
  const comment = 'Тут герой не мог знать про маяк.'
  await comments.getByLabel('Новый комментарий').fill(comment)
  await comments.getByRole('button', { name: 'Написать' }).click()
  await expect(comments.getByText(comment)).toBeVisible({ timeout: 30_000 })
  // Поле очистилось: иначе второе нажатие отправило бы то же самое ещё раз.
  await expect(comments.getByLabel('Новый комментарий')).toHaveValue('')
  const badge = page.locator('.ed-row--chapter .ed-row__comments').first()
  await expect(badge).toHaveText('1', { timeout: 30_000 })

  // 4. Комментарий живёт на сервере, а не только в состоянии компонента.
  await page.reload()
  await expect(page.locator('[data-frame-comments]')).toContainText(comment, { timeout: 45_000 })
  await expect(page.locator('.ed-row--chapter .ed-row__comments').first()).toHaveText('1')

  // 5. Свой комментарий можно удалить — вместе со счётчиком в дереве.
  await page
    .locator('[data-frame-comments]')
    .getByRole('button', { name: /Удалить комментарий/ })
    .click()
  await expect(page.locator('[data-frame-comments]')).not.toContainText(comment, { timeout: 30_000 })
  await expect(page.locator('.ed-row--chapter .ed-row__comments')).toHaveCount(0, { timeout: 30_000 })
})

/**
 * Колокольчик в шапке — виден вошедшему и говорит правду про пустое состояние.
 *
 * Своего замечания в счётчике быть не должно (чужое — считается, своё нет), поэтому после
 * сценария выше, где замечание написал сам человек и сразу прочитал, честный ответ —
 * «Новых замечаний нет». Проверяем именно это: счётчик не выдумывает работу.
 */
test('колокольчик показывает, что новых замечаний нет, и не врёт счётчиком', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const bell = page.locator('[data-notify-bell]')
  await expect(bell).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-notify-count]')).toHaveCount(0)

  await bell.click()
  const panel = page.locator('[data-notify-panel]')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Новых замечаний нет')
  // Esc закрывает: панель поверх шапки не должна оставаться «приклеенной».
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

/**
 * Согласие на письма о замечаниях — галочка в профиле, и по умолчанию она снята.
 *
 * Проверяем именно умолчание: текст проекта уходит на почтовый сервер, и включаться это
 * должно только осознанно (docs/comments.md §5.2).
 */
test('в профиле есть галочка «присылать замечания на почту», по умолчанию снята', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  await page.goto('/coauthors')
  const toggle = page.locator('[data-notify-comments]')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await expect(toggle).not.toBeChecked()
  // И рядом честное объяснение, что текст уходит на почтовый сервер.
  await expect(page.getByText(/письмо уходит на почтовый сервер/i)).toBeVisible()
})
