import { test, expect } from '@playwright/test'
import { apiHeaders, openEditorsTab, openEntityGroup, openProjectTab, signIn } from './support'

/**
 * Хронология карточки и перенос проекта архивом (0.97.8).
 *
 * Почему отдельный сценарий. `docs/entity-links.md`, фаза 4, обещала e2e
 * «создать персонажа → упомянуть → увидеть в хронологии → экспорт/импорт», а проверялись
 * только чипы упоминаний в кадре (`mentions.spec.ts`), скачивание книги (`export.spec.ts`) и
 * перенос архива на бэкенде (`transfer_entities_test.go`). Дыру видел только живой
 * `tests/project-transfer.ts`, который в CI не гоняется.
 *
 * Здесь проверяется то, что видит человек: «Где встречается» показывает кадр с упоминанием и
 * ведёт в него; после переноса архивом на другом конце карточка по-прежнему связана с текстом
 * (счётчик упоминаний не ноль). Связь не хранится в архиве отдельной строкой — она
 * пересчитывается из текста, и именно это мы подтверждаем: текст уехал, карточка уехала, связь
 * осталась.
 */
test.setTimeout(240_000)

const CARD = 'Анна'
const BODY = 'Анна вошла в дом. Анна долго ждала.'
const CHAPTER = 'Пролог'

test('хронология карточки ведёт в кадр, а после переноса архивом связь с текстом жива', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Хронология ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  const projectId = page.url().split('/').pop()
  expect(projectId).toMatch(/^[0-9a-f-]+$/)

  // Кадр — через интерфейс: текст живёт в CRDT.
  await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 60_000 })
  await openEditorsTab(page)
  const row = page.locator('.ed-row').first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  await page.getByPlaceholder('Заголовок события').fill(CHAPTER)
  await page.locator('.ed-editor textarea').first().fill(BODY)

  // Карточка — запросом: упоминания ищутся по имени и алиасам, форма тут ни при чём.
  const headers = await apiHeaders(page)
  const created = await page.request.post(`/api/projects/${projectId}/entities`, {
    headers,
    data: { name: CARD, kind: 'character' },
  })
  expect(created.status(), 'карточка «Анна»').toBe(201)

  // 1. Счётчик: два вхождения в одном кадре.
  await page.reload()
  await openProjectTab(page, 'relations')
  const panel = page.locator('details.ent')
  await panel.waitFor({ state: 'attached', timeout: 20_000 })
  if (!(await panel.evaluate((node: HTMLDetailsElement) => node.open))) {
    await panel.locator('summary').first().click()
  }
  // Группы по видам свёрнуты по умолчанию (0.111.0): карточка «Анна» лежит внутри группы
  // «Персонаж», и до её раскрытия ни строки, ни меню «⋮» на экране нет.
  await openEntityGroup(page, 'character')
  await expect(page.locator('[data-entity-usage]').first()).toHaveText('1 кадр · 2 упоминания', {
    timeout: 30_000,
  })

  // 2. Хронология: карточка знает, где встречается, и ведёт в этот кадр. С 0.102.0 пункт живёт в
  // меню «⋮»: сначала открываем его, как это делает человек.
  await page.getByLabel(`Действия с карточкой ${CARD}`).click()
  await page.getByLabel(`Где встречается ${CARD}`).click()
  const chronology = page.locator('[data-entity-frames]')
  await expect(chronology).toBeVisible()
  const frameRow = chronology.locator('[data-entity-frame]').first()
  await expect(frameRow).toContainText(CHAPTER)
  await frameRow.click()
  await expect(page.locator('[data-project-tab="editors"]')).toHaveClass(/is-active|active/, {
    timeout: 20_000,
  })
  await expect(page.getByPlaceholder('Заголовок события')).toHaveValue(CHAPTER)

  // 3. Перенос архивом: экспорт → (как на другом стенде) удаление исходника → импорт.
  // Исходник удаляем ОКОНЧАТЕЛЬНО, а не в корзину: идентификаторы кадров в базе уникальны, и
  // сервер справедливо отказывает импорту, пока события из архива ещё лежат в базе
  // (`ErrAlreadyImported`). Корзина событий не удаляет — значит, «другой стенд» честно
  // имитируется только очисткой. Это же объясняет, почему в `project-transfer.ts` перенос
  // проверяется после удаления проекта.
  const exported = await page.request.get(`/api/projects/${projectId}/export`, { headers })
  expect(exported.status(), 'экспорт архива').toBe(200)
  const archive = await exported.body()
  expect(archive.byteLength).toBeGreaterThan(1000)

  const deleted = await page.request.delete(`/api/projects/${projectId}`, { headers })
  expect([200, 204], 'исходный проект убран в корзину').toContain(deleted.status())
  const purged = await page.request.delete(`/api/projects/${projectId}/purge`, { headers })
  expect([200, 204], 'исходный проект удалён окончательно').toContain(purged.status())

  const imported = await page.request.post('/api/projects/import', {
    headers,
    multipart: {
      file: { name: 'project.skyfraze.zip', mimeType: 'application/zip', buffer: archive },
    },
  })
  expect(imported.status(), 'импорт архива').toBe(201)
  const importedBody = (await imported.json()) as { project?: { id?: string }; events?: number }
  const importedId = importedBody.project?.id
  expect(importedId, 'у импортированного проекта есть id').toBeTruthy()
  expect(importedBody.events ?? 0, 'кадры приехали').toBeGreaterThan(0)

  await page.goto(`/projects/${importedId}`)
  await openProjectTab(page, 'relations')
  const importedPanel = page.locator('details.ent')
  await importedPanel.waitFor({ state: 'attached', timeout: 20_000 })
  if (!(await importedPanel.evaluate((node: HTMLDetailsElement) => node.open))) {
    await importedPanel.locator('summary').first().click()
  }
  // Карточка на месте, и связь с текстом не потерялась: перенос не хранит упоминания, он
  // переносит текст и карточки — совпадение должно остаться.
  await openEntityGroup(page, 'character')
  await expect(page.locator('.ent__name', { hasText: CARD }).first()).toBeVisible({ timeout: 30_000 })
  const usage = page.locator('[data-entity-usage]').first()
  await expect(usage).toHaveText('1 кадр · 2 упоминания', { timeout: 30_000 })

  // Уборка: перенесённый проект — свой, удаляем запросом.
  const removed = await page.request.delete(`/api/projects/${importedId}`, { headers })
  expect([200, 204], 'удаление перенесённого проекта').toContain(removed.status())
})
