import { test, expect } from '@playwright/test'
import { signIn } from './support'

/**
 * «О проекте» (0.114.0) — страница вместо подвала сайта.
 *
 * Почему не только unit-тест. Unit проверяет разметку с подставленным API; здесь проверяется то,
 * чего в нём нет: страница открывается БЕЗ ВХОДА (витрина проекта читается до регистрации), номер
 * сборки приезжает с живого сервера, и на телефоне ссылка действительно лежит в меню «Ещё», а не
 * уехала за край экрана — ровно та беда, из-за которой меню и появилось в 0.78.0.
 */
test('«О проекте» открывается без входа, показывает сборку и живёт в меню на телефоне', async ({
  page,
}) => {
  // 1. Аноним: страница доступна, версия пришла с сервера, ключевые ссылки на месте.
  await page.goto('/about')
  await expect(page.getByRole('heading', { name: 'О проекте' })).toBeVisible({ timeout: 20_000 })

  const build = page.locator('[data-about-version]')
  // Версия на dev-стенде собирается без ldflags и равна `dev`; проверяем не формат версии, а то,
  // что номер сборки действительно приехал с сервера (это и было сломано до 0.114.0 в dev-режиме).
  await expect(build).toContainText('Сборка', { timeout: 20_000 })
  await expect(build).not.toContainText('неизвестна')

  await expect(page.locator('a[href*="/blob/master/LICENSE"]').first()).toBeVisible()
  await expect(page.locator('a[href*="docs/run.en.md"]').first()).toBeVisible()
  await expect(page.locator('[data-about] [lang="en"]')).toBeVisible()
  // Ответ «что это» — первым экраном, а не после прокрутки: страницу открывают, чтобы понять,
  // куда попали.
  await expect(page.locator('.about__lead')).toContainText('SkyFraze')

  // 2. Телефон: «О проекте» — в меню «Ещё», переход работает. До 0.78.0 разделы уезжали за правый
  //    край без всякого признака, что они есть; здесь проверяем, что пункт именно в меню.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/feed')
  const more = page.getByRole('button', { name: 'Ещё разделы' })
  await expect(more).toBeVisible({ timeout: 20_000 })
  await more.click()
  const item = page.getByRole('menuitem', { name: 'О проекте' })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByRole('heading', { name: 'О проекте' })).toBeVisible()

  // 3. Вошедшему страница тоже доступна (шапка с полной навигацией) — и она не ломает вход.
  expect(await signIn(page)).toBe(true)
  await page.goto('/about')
  await expect(page.getByRole('heading', { name: 'О проекте' })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-about-version]')).toContainText('Сборка')
  await expect(page.locator('[data-about-version]')).not.toContainText('неизвестна')
})
