import { test, expect } from '@playwright/test'
import { signIn } from './support'

/**
 * Корзина проектов: главное обещание проверяется живым интерфейсом.
 *
 * Сценарий повторяет путь человека, который удалил не тот проект: удалил → нашёл в корзине →
 * вернул. И вторую половину: удалил окончательно → проекта нет ни в списке, ни в корзине.
 *
 * Почему e2e, а не только юнит-тесты. Обещание «вернуть можно 30 дней» держится на трёх
 * местах сразу — кнопка удаления, список корзины и ручка восстановления. Каждое по
 * отдельности может быть верным, а вместе давать «удалил и не нашёл» — это и был бы самый
 * дорогой баг интерфейса для писателя.
 */
test('проект уезжает в корзину и возвращается, а «навсегда» — уже нет', async ({ page }) => {
  test.skip(!(await signIn(page)), 'на этом стенде нет доступа — сценарий пропущен')

  // Подтверждения удаления принимаются сразу: диалог браузера в тесте иначе блокирует клик.
  page.on('dialog', (dialog) => void dialog.accept())

  const title = `Корзина ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать', exact: true }).click()

  const projectLink = page.getByRole('link', { name: title })
  await expect(projectLink).toBeVisible()
  const card = page.locator('.card').filter({ has: projectLink })
  await card.getByRole('button', { name: 'Удалить', exact: true }).click()

  // Удалённый проект пропадает из списка — и «исчезает» не бесследно: кнопка корзины
  // говорит числом, что там что-то есть.
  await expect(projectLink).toHaveCount(0)
  await page.locator('[data-trash-toggle]').click()
  const panel = page.locator('[data-project-trash]')
  await expect(panel).toBeVisible()

  const item = panel.locator('[data-trash-item]').filter({ hasText: title })
  await expect(item).toBeVisible()
  // Срок — обещание, и он написан на экране, а не подразумевается.
  await expect(item).toContainText('вернуть можно ещё 30 дней')

  // «Удалить можно, а посмотреть — нельзя» не порядок: архив скачивается и из корзины,
  // не возвращая проект в список.
  const download = page.waitForEvent('download')
  await item.getByRole('button', { name: 'Скачать архив' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.zip$/)
  await expect(item).toBeVisible() // проект остался в корзине

  await item.getByRole('button', { name: 'Вернуть' }).click()
  await expect(page.getByRole('link', { name: title })).toBeVisible()
  await expect(panel.locator('[data-trash-item]').filter({ hasText: title })).toHaveCount(0)

  // Окончательное удаление: из того же места, но другой кнопкой и без возврата.
  await page.locator('[data-trash-toggle]').click() // свернуть пустую корзину
  await expect(panel).toHaveCount(0)
  const again = page.locator('.card').filter({ has: page.getByRole('link', { name: title }) })
  await again.getByRole('button', { name: 'Удалить', exact: true }).click()
  await page.locator('[data-trash-toggle]').click()
  const trashItem = page
    .locator('[data-project-trash] [data-trash-item]')
    .filter({ hasText: title })
  await expect(trashItem).toBeVisible()
  await trashItem.getByRole('button', { name: 'Удалить навсегда' }).click()

  await expect(trashItem).toHaveCount(0)
  await expect(page.getByRole('link', { name: title })).toHaveCount(0)
})
