import { test, expect } from '@playwright/test'
import { signIn } from './support'

/**
 * История версий через браузер: сохранить версию, посмотреть, что в ней, восстановить.
 *
 * Зачем отдельный сценарий, если есть интеграционные тесты Go. Те проверяют сервер: версия
 * снимается, восстанавливается, попадает в снапшот и проекцию. Здесь проверяется то, чего
 * в них нет, — что окно открывается, версия приходит с сервера, предпросмотр показывает
 * дерево, а восстановление требует подтверждения. Один раз это уже спасло: сервер отдавал
 * `revision`, а клиент ждал `version`, и предпросмотр не появлялся вовсе — интеграционные
 * тесты были зелёными.
 */
test.setTimeout(120_000)

/** Заводит проект с одной главой через интерфейс и возвращает его название. */
async function projectWithChapter(page: import('@playwright/test').Page): Promise<string> {
  const title = `Версии ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
  // Пустой проект: «Добавить первую главу» создаёт кадр «Новая глава» и синхронизирует его.
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  // 0.83.0: правка живёт на вкладке «Редакторы» — до неё вкладки «Проект» не было вовсе.
  await page.locator('[data-project-tab="editors"]').click()
  await expect(page.locator('.ed-row--chapter', { hasText: 'Новая глава' }).first()).toBeVisible({
    timeout: 30_000,
  })
  // Перезагружаем страницу перед снятием версии: документ живёт у клиента и уезжает на
  // сервер по сокету, а версия снимается по СЕРВЕРНОМУ состоянию. Без перезагрузки
  // сценарий проверял бы гонку «нажал раньше, чем доехало», а не историю версий.
  // Пользователю это не мешает: он нажимает «Сохранить версию» через секунды, а не
  // через миллисекунды после первой правки.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-project-tab="editors"]').click()
  await expect(page.locator('.ed-row--chapter', { hasText: 'Новая глава' }).first()).toBeVisible({
    timeout: 45_000,
  })
  return title
}

test('версия сохраняется, показывается и восстанавливается', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await projectWithChapter(page)

  // 1. Окно версий.
  await page.locator('[data-versions-open]').click()
  const modal = page.locator('.sf-versions__window')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('История версий')).toBeVisible()

  // 2. Сохраняем версию вручную — с подписью, чтобы её было видно в списке.
  await modal.getByLabel('Подпись версии').fill('перед правками')
  await modal.getByRole('button', { name: 'Сохранить версию' }).click()
  await expect(page.locator('[data-versions-note]')).toContainText('Версия сохранена', {
    timeout: 30_000,
  })
  const item = modal.locator('.sf-versions__item', { hasText: 'перед правками' })
  await expect(item).toBeVisible({ timeout: 45_000 })
  await expect(item).toContainText('Вручную · перед правками')
  // Число кадров и объём — с цифрами, а не одним словом «кадра». Ноль кадров здесь был бы
  // провалом: значит версия снялась до того, как кадр доехал до сервера.
  await expect(item).toContainText(/[1-9]\d* кадр/)

  // 3. Предпросмотр: что именно вернётся.
  await item.getByRole('button', { name: 'Показать' }).click()
  const preview = page.locator('[data-versions-preview]')
  await expect(preview).toBeVisible({ timeout: 45_000 })
  await expect(preview).toContainText('Новая глава', { timeout: 45_000 })
  await expect(preview).toContainText(/знак/)

  // 4. Восстановление требует подтверждения: первое нажатие только спрашивает.
  const restore = item.getByRole('button', { name: 'Восстановить' })
  await restore.click()
  await expect(item.getByRole('button', { name: 'Точно восстановить?' })).toBeVisible()
  await item.getByRole('button', { name: 'Точно восстановить?' }).click()
  // Версия та же, что и проект, — сервер честно отвечает «менять нечего».
  await expect(page.locator('[data-versions-note]')).toContainText(/восстановлен|менять нечего/, {
    timeout: 30_000,
  })

  // 5. Окно закрывается и не мешает работать дальше.
  await modal.getByRole('button', { name: 'Закрыть' }).click()
  await expect(modal).toBeHidden()
  await expect(page.locator('[data-versions-open]')).toBeVisible()
})
