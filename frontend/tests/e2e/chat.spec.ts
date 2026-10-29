import { test, expect } from '@playwright/test'
import { apiHeaders, signIn } from './support'

/**
 * Общий чат проекта в CI (0.99.2).
 *
 * До этого у чата не было НИ ОДНОГО e2e-сценария: он проверялся только живым `diag-chat.ts`,
 * который CI не запускает. Фича выросла (ответы, правка, ссылки на кадры, «@Нестор», отметки), и
 * регрессии в ней ловились глазами.
 *
 * Здесь — то, что видно человеку и ломается молча: сообщение уезжает на сервер и переживает
 * перезагрузку, отметка ставится нажатием и переключается, а «показать прежние» подгружает старые
 * сообщения СВЕРХУ. Бота не зовём: он зависит от заглушки модели и проверяется своим сценарием.
 */
test.setTimeout(180_000)

test('чат проекта: сообщение переживает перезагрузку, отметка ставится, история листается назад', async ({
  page,
}) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Чат ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  const projectId = page.url().split('/').pop()
  expect(projectId).toMatch(/^[0-9a-f-]+$/)
  const headers = await apiHeaders(page)

  // Достаточно «дырки» из ста сообщений, чтобы первая страница была полной и появилась кнопка
  // «показать прежние»: так проверяется и листание назад, которое раньше было недоступно вовсе.
  for (let index = 0; index < 101; index += 1) {
    const response = await page.request.post(`/api/projects/${projectId}/chat/messages`, {
      headers,
      data: { body: `сообщение ${index + 1}` },
    })
    expect(response.status(), `сообщение ${index + 1}`).toBe(201)
  }

  const openChat = async () => {
    await page.locator('[data-assistant-fab]').click({ timeout: 30_000 })
    const panel = page.locator('[data-assistant-panel]')
    await panel.waitFor({ state: 'visible', timeout: 20_000 })
    await panel.locator('[data-dock-tab="chat"]').click()
    await panel.locator('[data-project-chat]').waitFor({ state: 'visible', timeout: 20_000 })
    return panel
  }

  let panel = await openChat()
  // 1. Лента открылась последними сообщениями — и предлагает прежние (страница была полной).
  await expect(panel.getByText('сообщение 101', { exact: true })).toBeVisible({ timeout: 20_000 })
  const older = panel.locator('[data-chat-older]')
  // Ждём столько же, сколько соседние проверки (0.120.1). Здесь стояли дефолтные 5 с, и на
  // загруженном раннере второй ночной прогон падал именно тут: сообщения уже отрисованы, а
  // управление «показать прежние» приходит следом (флаг «есть ещё» считается по ответу сервера).
  // Пять секунд — это про скорость машины, а не про поведение интерфейса.
  await expect(older).toBeVisible({ timeout: 20_000 })
  await older.click()
  // Старые сообщения добавляются СВЕРХУ: видно начало разговора, которого раньше было не достать.
  await expect(panel.getByText('сообщение 1', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('[data-chat-message]')).toHaveCount(101)

  // 2. Своё сообщение уезжает на сервер и переживает перезагрузку.
  await panel.getByLabel('Сообщение в чат проекта').fill('Проверка e2e: сообщение на месте?')
  await panel.getByRole('button', { name: 'Отправить' }).click()
  await expect(panel.getByText('Проверка e2e: сообщение на месте?')).toBeVisible({ timeout: 20_000 })
  await page.reload()
  panel = await openChat()
  await expect(panel.getByText('Проверка e2e: сообщение на месте?')).toBeVisible({ timeout: 20_000 })

  // 3. Отметка ставится нажатием и повторным нажатием снимается; состояние переживает перезагрузку
  // (значит, лежит на сервере, а не в памяти вкладки).
  const lastMessage = panel.locator('[data-chat-message]').last()
  const chip = lastMessage.locator('[data-chat-reaction$=":todo"]')
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await page.reload()
  panel = await openChat()
  const chipAfterReload = panel.locator('[data-chat-message]').last().locator('[data-chat-reaction$=":todo"]')
  await expect(chipAfterReload).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 })
  await chipAfterReload.click()
  await expect(chipAfterReload).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })

  // Уборка: проект свой, удаляем окончательно (как остальные сценарии с созданными проектами).
  await page.request.delete(`/api/projects/${projectId}`, { headers })
  await page.request.delete(`/api/projects/${projectId}/purge`, { headers })
})
