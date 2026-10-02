import { test, expect } from '@playwright/test'
import { E2E_ADMIN_EMAIL, PASSWORD } from './support'

/**
 * Первая регистрация на ЧИСТОЙ инсталляции — и единственное место, где проверяется,
 * что окно «Первый администратор» вообще открывается.
 *
 * Почему отдельный файл и отдельный проект в playwright.config.ts. Раньше этот
 * сценарий лежал в auth.spec.ts и пропускался, если форма показывала не «Первый
 * администратор»: файлы идут по алфавиту, а к моменту auth.spec администратора уже
 * регистрировал первый сценарий — значит, на чистой базе проверка не выполнялась
 * НИКОГДА. Так и проехали: миграция 0010 завела агенту строку в users, «сколько людей
 * на инсталляции» считалось как COUNT(*) FROM users, регистрация первого
 * администратора закрылась — а e2e остались зелёными, потому что вместо проверки
 * было «1 skipped».
 *
 * Теперь сценарий идёт первым (проект `install` объявлен до `chromium`) и в CI
 * НЕ имеет права пропускаться: на свежей базе форма обязана предлагать первого
 * администратора, иначе это провал с объяснением причины.
 *
 * Локально база не пустая (на стенде люди уже есть), поэтому там сценарий честно
 * пропускается, а не падает.
 */
test('register → login → /projects (чистая инсталляция)', async ({ page }) => {
  await page.goto('/register')
  const heading = await page.locator('h1').innerText()

  if (!/Первый администратор/.test(heading)) {
    const why = `инсталляция не пустая: «${heading}»`
    if (process.env.CI) {
      throw new Error(
        `${why}. В CI база поднимается заново, и на ней не должно быть ни одного человека: ` +
          'если форма предлагает заявку, значит в подсчёте людей оказался не человек ' +
          '(так было с системным аккаунтом агента — миграция 0010 + COUNT(*) FROM users). ' +
          'Смотрите CountUsers в backend/internal/store/store_admin.go и users.is_system.',
      )
    }
    test.skip(true, why)
  }

  await page.getByPlaceholder('имя').fill('E2E User')
  await page.getByPlaceholder('email').fill(E2E_ADMIN_EMAIL)
  await page.getByPlaceholder('пароль (мин. 8)').fill(PASSWORD)
  await page.getByRole('button', { name: /Создать/ }).click()

  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole('heading', { name: /Проекты/ })).toBeVisible()
})
