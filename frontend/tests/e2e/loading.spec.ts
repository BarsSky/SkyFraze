import { test, expect } from '@playwright/test'
import { signIn } from './support'

/**
 * Загрузка проекта: пока содержимое едет, показывается анимация, а не «таймлайн пуст».
 *
 * Что здесь проверяется и почему именно так. Пустой Y.Array до приезда снапшота и
 * по-настоящему пустой проект выглядят одинаково, и раньше на каждом открытии проекта
 * человек видел заглушку «Таймлайн пока пуст» с кнопкой «Добавить первую главу» —
 * вместо загрузки и с риском создать лишнюю главу. Сценарий придерживает запрос
 * снапшота (`/events/state`), поэтому состояние «идёт загрузка» видно так же, как его
 * видит человек на медленной связи.
 *
 * Вход общий с другими сценариями (tests/e2e/support.ts): на чистой базе администратора
 * регистрирует первый файл по алфавиту, остальные входят той же учётной записью.
 * Если войти нечем — сценарий честно пропускается, чтобы `npm run e2e` оставался
 * зелёным и на стендах с закрытой регистрацией.
 */
test('пока проект грузится, видно анимацию, а не «таймлайн пуст»', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  // Придерживаем снапшот состояния — тот самый запрос, из-за которого пустой документ
  // выглядел как пустой проект.
  await page.route('**/api/projects/*/events/state', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })

  const title = `Загрузка ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()

  // Загрузка: скелет с подписью, и НИ заглушки «пусто», ни кнопки создания главы.
  const loading = page.locator('[data-project-loading]')
  await expect(loading).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Таймлайн пока пуст' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Добавить первую главу/ })).toHaveCount(0)

  // Снапшот приехал: проект действительно пуст — вот теперь заглушка уместна.
  await expect(page.getByRole('heading', { name: 'Таймлайн пока пуст' })).toBeVisible({ timeout: 15_000 })
  await expect(loading).toHaveCount(0)
})
