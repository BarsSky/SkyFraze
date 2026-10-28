import { test, expect } from '@playwright/test'
import { apiHeaders, openEditorsTab, signIn } from './support'

/**
 * Упоминания в кадре — по отчёту 0.92.1: «упоминания дублируются слишком много раз… при большем
 * количестве будет расти список и вылезать».
 *
 * Проверяем то, что видно человеку: один чип на КАРТОЧКУ со счётчиком вхождений, длинный список
 * сворачивается в «ещё N», а повторное нажатие ведёт к следующему месту в тексте (иначе второе
 * вхождение стало бы недостижимым).
 *
 * Карточки создаются запросом (в интерфейсе это отдельная форма на вкладке «Связи» — проверять её
 * здесь значило бы проверять две фичи сразу), текст кадра — через интерфейс, потому что он живёт
 * в CRDT.
 */
test.setTimeout(180_000)

/** Девять карточек: больше лимита чипов (6), чтобы «ещё N» было видно. */
const ENTITIES = [
  'Юпитер', 'Ио', 'Европа', 'Ганимед', 'Каллисто', 'Амальтея', 'Гималия', 'Элара', 'Пасифе',
]

/** Ганимед назван трижды, Юпитер и Ио — по разу, остальные — по разу. */
const BODY = 'Юпитер и Ио были рядом. Ганимед спорил, Ганимед ждал.\n\nГанимед вернулся. Европа, Каллисто, Амальтея, Гималия, Элара, Пасифе.'

test('упоминания в кадре: один чип на карточку, счётчик и «ещё N»', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Упоминания ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  const projectId = page.url().split('/').pop()
  expect(projectId).toMatch(/^[0-9a-f-]+$/)

  // Кадр — через интерфейс.
  await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 60_000 })
  await openEditorsTab(page)
  const row = page.locator('.ed-row').first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  await page.getByPlaceholder('Заголовок события').fill('Глава')

  // Карточки — запросом: помощнику и импорту они тоже приходят не из формы.
  const headers = await apiHeaders(page)
  for (const name of ENTITIES) {
    const response = await page.request.post(`/api/projects/${projectId}/entities`, {
      headers,
      data: { name, kind: 'place' },
    })
    expect(response.status(), `карточка «${name}»`).toBe(201)
  }

  await page.locator('.ed-editor textarea').first().fill(BODY)
  // Список карточек панель читает при загрузке проекта — перезагружаем, чтобы он их увидел.
  await page.reload()
  await openEditorsTab(page)
  await page.locator('.ed-row').first().click()

  const mentions = page.locator('[data-frame-mentions]')
  await expect(mentions).toBeVisible({ timeout: 45_000 })

  // 1. Один чип на карточку: Ганимед назван трижды — чип один, со счётчиком.
  const ganymede = mentions.locator('[data-frame-mention]', { hasText: 'Ганимед' }).first()
  await expect(ganymede).toBeVisible()
  await expect(ganymede).toHaveAttribute('data-frame-mention-count', '3')
  await expect(ganymede).toContainText('×3')
  const ganymedeIds = await mentions.locator('[data-frame-mention]').evaluateAll((nodes) =>
    nodes.filter((node) => (node.textContent ?? '').includes('Ганимед')).length,
  )
  expect(ganymedeIds, 'чип «Ганимед» должен быть один').toBe(1)

  // 2. Лимит: видно 6 карточек из девяти, остальные за «ещё 3».
  await expect(mentions.locator('[data-frame-mention]')).toHaveCount(6)
  const more = mentions.getByRole('button', { name: /ещё 3/ })
  await expect(more).toBeVisible()
  await more.click()
  await expect(mentions.locator('[data-frame-mention]')).toHaveCount(9)
  await mentions.getByRole('button', { name: 'свернуть' }).click()
  await expect(mentions.locator('[data-frame-mention]')).toHaveCount(6)

  // 3. Повторное нажатие ведёт к следующему вхождению, а не к тому же месту.
  const bodyArea = page.locator('.ed-editor textarea').first()
  const positions: number[] = []
  for (let press = 0; press < 3; press += 1) {
    await ganymede.click()
    await page.waitForTimeout(150)
    positions.push(await bodyArea.evaluate((area: HTMLTextAreaElement) => area.selectionStart))
  }
  expect(new Set(positions).size, `выделения не меняются: ${positions.join(', ')}`).toBe(3)
})
