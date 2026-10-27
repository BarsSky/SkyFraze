import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab } from './support'

/**
 * Поиск по тексту проекта — через браузер.
 *
 * Что проверяется и почему не только юнит-тестами. Поиск идёт по CRDT-документу, который
 * открыт в браузере, а не по проекции на сервере: серверная отставала бы на период
 * сохранения комнаты и не видела бы несохранённых правок. Это значит, что проверять надо
 * именно браузер: есть ли поле поиска, находит ли оно кадр по слову из ТЕКСТА (а не
 * только по названию), показывает ли сниппет и что происходит при пустом результате.
 *
 * Текст главы создаёт заглушка провайдера (`stub-ollama.mjs`): «## Начало / Так
 * **начинается** история» — в нём есть слово, которого нет в названии кадра.
 */
test.setTimeout(180_000)

test('поиск находит кадр по слову из текста, а не только по названию', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Поиск ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  // Кадр с текстом: без него искать нечего.
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
  // Помощник закрываем: его окно перекрывает панель редакторов.
  await page.locator('[data-assistant-close]').click()

  const search = page.locator('[data-ed-search]')
  await expect(search).toBeVisible({ timeout: 15_000 })
  await expect(search).toHaveAttribute('placeholder', /тексту/)

  // 1. Слово есть только в тексте кадра — значит, поиск смотрит и в текст.
  await search.fill('начинается')
  const rows = page.locator('.ed-row')
  await expect(rows).toHaveCount(1, { timeout: 15_000 })
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' })).toBeVisible()
  // И показывает, ГДЕ совпадение: сниппет рядом со строкой.
  await expect(page.locator('[data-ed-snippet]').first()).toContainText('начинается')

  // 2. Слово из названия находится, но сниппет не рисуется — попадание в название.
  await search.fill('Пролог')
  await expect(page.locator('.ed-row')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.locator('[data-ed-snippet]')).toHaveCount(0)

  // 3. Пустой результат честно говорит, что ничего не найдено.
  await search.fill('нет-такого-слова')
  await expect(page.locator('.ed-row')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText('Ничего не найдено.')).toBeVisible()
  await expect(page.getByText(/найдено 0 из/)).toBeVisible()

  // 4. Очистка возвращает весь список: поиск — фильтр, а не режим.
  await search.fill('')
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Пролог' })).toBeVisible({
    timeout: 15_000,
  })
})
