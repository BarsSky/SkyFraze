import { test, expect } from '@playwright/test'
import { openProjectTab, signIn } from './support'

/**
 * Английский интерфейс на всех экранах (0.131.0) — проверка ЖИВОГО стенда после того, как
 * локализация закрыта (0.129.0) и закреплена тестом-стражем (0.130.0).
 *
 * Что проверяется здесь, а не в unit-тестах:
 *   1) подписи действительно приезжают из словаря на КАЖДОМ экране рабочей части — вкладки
 *      проекта, «Связи», «Версии», настройки, профиль, резиденты, соавторы, админка;
 *   2) английские подписи не ломают вёрстку: они в среднем длиннее русских, и риск «Button
 *      перестал помещаться на 390 px» записан в docs/ui-localization.md. Поэтому на каждом
 *      экране проверяется отсутствие горизонтального переполнения на телефоне.
 *
 * Язык ставится в localStorage до первой навигации: сценарий не зависит от того, каким
 * язык остался от предыдущего файла.
 */

const EN = 'en'

/** Горизонтальное переполнение: сколько пикселей контента не влезло в окно. */
async function overflowX(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

test('английский интерфейс: экраны переведены и не ломают вёрстку на телефоне', async ({ page }) => {
  await page.addInitScript((lang) => window.localStorage.setItem('skyfraze-lang', lang), EN)
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  // Язык документа — английский: интерфейс не «наполовину переведён».
  expect(await page.evaluate(() => document.documentElement.lang)).toBe(EN)

  // Проект создаём через интерфейс, чтобы заодно проверить его подписи по-английски.
  const title = `i18n screens ${Date.now()}`
  await page.goto('/projects')
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '+ New project' }).click()
  await page.getByPlaceholder('Name').fill(title)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.getByRole('link', { name: title }).click()
  const projectId = page.url().split('/').pop()
  expect(projectId).toMatch(/^[0-9a-f-]+$/)

  // Вкладки появляются, когда в проекте есть содержимое: создаём первую главу по-английски.
  await page.getByRole('button', { name: '+ Add the first chapter' }).click({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: '+ Add the first chapter' })).toHaveCount(0)

  // Вкладки режимов проекта: подписи из словаря (role=tab), а не русские константы.
  const tabs = page.getByRole('tablist', { name: 'Project view' })
  await expect(tabs).toBeVisible({ timeout: 30_000 })
  for (const label of ['Project', 'Editors', 'Relations', 'Versions', 'Settings']) {
    await expect(tabs.getByRole('tab', { name: label })).toBeVisible()
  }

  // Стадия: кадр главы подписан по-английски («Chapter», а не «Глава»), навигация тоже.
  await expect(page.locator('.sf-copy__eyebrow').first()).toHaveText(/Chapter/i, {
    timeout: 30_000,
  })
  await expect(page.locator('.sf-copy__meta').first()).toContainText(/chapter|frames|sub-events/)
  await expect(page.locator('.sf-copy__nav').first()).toContainText(/back|next|timeline/)

  // «Связи»: заголовок раздела и статистика проекции.
  await openProjectTab(page, 'relations')
  await expect(page.locator('[data-relations]')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Relations' })).toBeVisible()
  await expect(page.locator('[data-relations-stats]')).toContainText('cards:')

  // «Версии»: заголовок истории версий по-английски.
  await openProjectTab(page, 'versions')
  await expect(page.getByRole('region', { name: 'Version history' })).toBeVisible({
    timeout: 30_000,
  })

  // Настройки проекта: заголовок карточки участников и блок шаблона.
  await page.goto(`/projects/${projectId}/settings`)
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Project template' })).toBeVisible()

  // Профиль, резиденты, соавторы, админка — по одному заголовку на экран.
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'How people find you' })).toBeVisible()

  await page.goto('/people')
  await expect(page.getByRole('heading', { name: 'Residents' })).toBeVisible({ timeout: 30_000 })

  await page.goto('/coauthors')
  await expect(page.getByRole('heading', { name: 'Co-authors', exact: true })).toBeVisible({
    timeout: 30_000,
  })

  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('heading', { name: 'Registration' })).toBeVisible()

  // Вёрстка на телефоне: английские подписи не должны вылезать за экран.
  await page.setViewportSize({ width: 390, height: 844 })
  for (const route of [
    '/projects',
    `/projects/${projectId}`,
    `/projects/${projectId}/settings`,
    '/profile',
    '/people',
    '/coauthors',
    '/admin',
  ]) {
    await page.goto(route)
    await page.waitForTimeout(600)
    expect(await overflowX(page), `переполнение по горизонтали: ${route}`).toBe(0)
  }
})
