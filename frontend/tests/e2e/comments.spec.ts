import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab } from './support'

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
  await openEditorsTab(page)
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
  // Упоминание набирается через подсказку: ник — латиница из email, и по памяти его никто
  // не набирает. Проверяем и подсказку, и подсветку: это единственное место, где разбор
  // «@ник» живёт в двух реализациях (сервер и интерфейс).
  const comment = 'Тут герой не мог знать про маяк.'
  const field = comments.getByLabel('Новый комментарий')
  await field.fill(`${comment} @`)
  const mentionMenu = comments.locator('[data-frame-mention-menu]')
  await expect(mentionMenu).toBeVisible()
  await mentionMenu.locator('button').first().click()
  await expect(field).toHaveValue(/@[a-z0-9_.-]+ $/)
  await comments.getByRole('button', { name: 'Написать' }).click()
  await expect(comments.getByText(comment, { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(comments.locator('[data-frame-mention]').first()).toBeVisible()
  // Поле очистилось: иначе второе нажатие отправило бы то же самое ещё раз.
  await expect(comments.getByLabel('Новый комментарий')).toHaveValue('')
  const badge = page.locator('.ed-row--chapter .ed-row__comments').first()
  await expect(badge).toHaveText('1', { timeout: 30_000 })

  // 3.1. Ответ веткой: он стоит под замечанием, а не отдельной строкой, и счётчик растёт.
  const reply = 'Согласен, перепишу сцену.'
  await comments.getByRole('button', { name: 'Ответить' }).first().click()
  const replyField = comments.getByLabel('Ответ на замечание')
  await expect(replyField).toBeVisible()
  await replyField.fill(reply)
  await comments.locator('[data-frame-reply-form]').getByRole('button', { name: 'Ответить' }).click()
  await expect(comments.getByText(reply)).toBeVisible({ timeout: 30_000 })
  await expect(comments.locator('[data-frame-comment-reply="1"]')).toHaveCount(1)
  await expect(badge).toHaveText('2', { timeout: 30_000 })

  // 4. Обсуждение живёт на сервере, а не только в состоянии компонента.
  await page.reload()
  await openEditorsTab(page)
  // После перезагрузки сначала ждём дерево: на пустой базе проекция доезжает не сразу, и
  // без этого ожидания панель обсуждения ещё не отрисована (падало «element(s) not found»,
  // хотя данные целы). Это ожидание состояния, а не «подождать на всякий случай».
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()).toBeVisible({
    timeout: 45_000,
  })
  await expect(page.locator('[data-frame-comments]')).toContainText(comment, { timeout: 45_000 })
  await expect(page.locator('[data-frame-comments]')).toContainText(reply, { timeout: 45_000 })
  await expect(page.locator('.ed-row--chapter .ed-row__comments').first()).toHaveText('2')

  // 4.1. Реакции: «согласен» ставится одним нажатием и переживает перезагрузку.
  // Переписка ради «да, поправлю» — ровно тот шум, ради устранения которого они заведены.
  const agree = comments.locator('[data-frame-reaction^="agree:"]').first()
  await expect(agree).toHaveAttribute('aria-pressed', 'false')
  await agree.click()
  await expect(comments.locator('[data-frame-reaction="agree:1"]').first()).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.reload()
  await openEditorsTab(page)
  await expect(
    page.locator('[data-frame-comments] [data-frame-reaction="agree:1"]').first(),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 45_000 })
  // Снятие возвращает счётчик в ноль — реакция это состояние, а не след навсегда.
  await page.locator('[data-frame-comments] [data-frame-reaction="agree:1"]').first().click()
  await expect(
    page.locator('[data-frame-comments] [data-frame-reaction="agree:0"]').first(),
  ).toBeVisible()

  // 4.2. Замечание к ФРАГМЕНТУ: выделяем кусок текста в редакторе и ставим замечание к нему.
  // Якорь — Y.RelativePosition, поэтому после перезагрузки цитата остаётся привязанной к тому
  // же тексту, а не к «пятому символу пятой строки».
  const bodyArea = page.locator('.ed-form textarea').first()
  await bodyArea.click()
  await page.keyboard.press('Control+Home')
  // Настоящее выделение клавиатурой: React-овский onSelect слушает нативные события, и
  // синтетически отправленный `select` его не будит.
  await page.keyboard.down('Shift')
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  await page.locator('[data-select-fragment]').click()
  const pending = page.locator('[data-frame-anchor-pending]')
  await expect(pending).toBeVisible()
  const quoted = (await pending.textContent()) ?? ''
  expect(quoted.length).toBeGreaterThan(0)

  const fragmentComment = 'К этому куску замечание.'
  await page.getByLabel('Новый комментарий').fill(fragmentComment)
  await page.getByRole('button', { name: 'Написать' }).click()
  await expect(page.locator('[data-frame-comments]')).toContainText(fragmentComment, { timeout: 30_000 })
  // Цитата фрагмента видна и привязана к живому тексту (статус ok, а не «удалён»).
  await expect(page.locator('[data-frame-comments] [data-frame-anchor="ok"]').first()).toBeVisible()
  // Панель забрала фрагмент: следующее замечание не должно молча уехать к тому же куску.
  await expect(page.locator('[data-frame-anchor-pending]')).toHaveCount(0)

  await page.reload()
  await openEditorsTab(page)
  await expect(
    page.locator('[data-frame-comments] [data-frame-anchor="ok"]').first(),
  ).toBeVisible({ timeout: 45_000 })

  // 4.3. «Показать в тексте»: замечание к фрагменту находит свой кусок в поле кадра.
  // Проверяем выделение в самом textarea — именно это видит человек, а не разметку панели.
  await page.locator('[data-frame-comments] [data-frame-anchor-show]').first().click()
  const selected = await page.locator('.ed-form textarea').first().evaluate((el) => {
    const area = el as HTMLTextAreaElement
    return { from: area.selectionStart, to: area.selectionEnd, text: area.value.slice(area.selectionStart, area.selectionEnd) }
  })
  expect(selected.to).toBeGreaterThan(selected.from)
  expect(selected.text.length).toBeGreaterThan(0)

  // 5. Свой комментарий можно удалить. Удаление мягкое: замечание остаётся строкой
  // «Комментарий удалён», а ответ на него — живым. Жёсткое удаление унесло бы чужой текст.
  await page
    .locator('[data-frame-comments]')
    .getByRole('button', { name: /Удалить комментарий/ })
    .first()
    .click()
  await expect(page.locator('[data-frame-comments]')).not.toContainText(comment, { timeout: 30_000 })
  await expect(page.locator('[data-frame-comments]')).toContainText('Комментарий удалён')
  await expect(page.locator('[data-frame-comments]')).toContainText(reply)
  // В счётчике остались живые: ответ на удалённое замечание и замечание к фрагменту.
  // Удалённое не считается — иначе счётчик звал бы к «(удалён)».
  await expect(page.locator('.ed-row--chapter .ed-row__comments').first()).toHaveText('2', { timeout: 30_000 })
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
