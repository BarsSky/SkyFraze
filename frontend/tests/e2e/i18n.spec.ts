import { test, expect } from '@playwright/test'

/**
 * Язык интерфейса (0.115.0) — фаза 1: шапка, «О проекте», вход и регистрация.
 *
 * Что проверяется здесь, а не в unit-тестах: переключение на ЖИВОЙ странице без перезагрузки,
 * сохранение выбора между загрузками (`localStorage`) и то, что на телефоне переключатель доступен
 * из меню «Ещё», а не спрятан за краем экрана. Unit-тесты подменяют медиазапросы, поэтому до
 * реального 390 px доходит только этот сценарий.
 */
test('язык переключается EN ↔ RU, выбор переживает перезагрузку, на телефоне живёт в меню', async ({
  page,
}) => {
  await page.goto('/feed')
  // 1. По умолчанию русский — и это язык документа, а не только подписи.
  await expect(page.getByRole('navigation').getByText('Лента')).toBeVisible({ timeout: 20_000 })
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru')

  // 2. Переключение на английский без перезагрузки.
  await page.getByRole('button', { name: 'Переключить язык' }).click()
  await expect(page.getByRole('navigation').getByText('Feed')).toBeVisible()
  await expect(page.getByRole('navigation').getByText('Лента')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')

  // 3. Выбор переживает перезагрузку: это не «состояние на один экран».
  await page.reload()
  await expect(page.getByRole('navigation').getByText('Feed')).toBeVisible({ timeout: 20_000 })

  // 4. «О проекте» на английском: заголовок и содержимое переведены, а номер сборки на месте —
  //    страница остаётся полезной, а не превращается в заглушку.
  await page.goto('/about')
  await expect(page.getByRole('heading', { name: 'About', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.locator('[data-about-version]')).toContainText('Build')
  await expect(page.getByRole('heading', { name: 'License' })).toBeVisible()

  // 5. Обратно на русский — и «О проекте» снова по-русски.
  await page.getByRole('button', { name: 'Switch language' }).click()
  await expect(page.getByRole('heading', { name: 'О проекте' })).toBeVisible()

  // 6. Телефон: в строке переключателя нет, он в меню «Ещё»; пункт подписан языком, на который
  //    переключит, и работает.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/feed')
  await expect(page.getByRole('button', { name: 'Переключить язык' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Ещё разделы' }).click()
  const item = page.getByRole('menuitem', { name: 'English' })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.getByRole('navigation').getByText('Feed')).toBeVisible()
  // Меню закрылось само после выбора.
  await expect(page.getByRole('menu')).toHaveCount(0)
})
