import { test, expect, type Page } from '@playwright/test'
import { signIn } from './support'

/**
 * Файлы проекта: загрузка нескольких файлов сразу и перенос вложения между кадрами.
 *
 * Почему именно так проверяем. Загрузка идёт СЕРВЕРОМ (он пережимает картинки, считает
 * квоту и решает, как назвать файл), а привязка к кадру живёт только в CRDT-документе
 * клиента. Значит, в браузере нужно проверить весь путь: два файла одним выбором →
 * оба в списке → привязка к главе → перенос в под-событие → подпись «где файл» это
 * подтверждает. Unit-тесты этого не увидят: там и сервер, и документ подменены.
 *
 * Вход общий с другими сценариями (tests/e2e/support.ts); если войти нечем, сценарий
 * пропускается, чтобы `npm run e2e` оставался зелёным и на стенде с закрытой
 * регистрацией.
 */

/** Крошечная валидная PNG-картинка: сервер принимает только картинки и pdf/svg. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
)

async function makeProject(page: Page): Promise<void> {
  const title = `Файлы ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
}

/** Значения непустых вариантов в выборе кадра (первый — «выберите кадр…»). */
async function frameOptions(row: ReturnType<Page['locator']>): Promise<string[]> {
  return row
    .getByLabel(/Кадр для/)
    .locator('option')
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
    )
}

test('два файла одним выбором и перенос вложения между кадрами', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await makeProject(page)

  // Кадры: глава и под-событие внутри неё. В пустом проекте панель редакторов ещё не
  // показана — первый кадр создаётся кнопкой пустого состояния, дальше работает панель.
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  const panel = page.locator('[data-editor-panel]')
  await expect(panel.locator('.ed-row')).toHaveCount(1)
  await page.getByRole('button', { name: '+ подсобытие' }).click()
  await expect(panel.locator('.ed-row')).toHaveCount(2)

  // Панель редакторов и список файлов на месте.
  const files = page.locator('.ed-files')
  await expect(files).toBeVisible()

  // Два файла ОДНИМ выбором: раньше в поле стоял один файл.
  const input = files.locator('input[type="file"]')
  await expect(input).toHaveAttribute('multiple', '')
  await input.setInputFiles([
    { name: 'обложка.png', mimeType: 'image/png', buffer: PNG },
    { name: 'схема.png', mimeType: 'image/png', buffer: PNG },
  ])

  // Оба файла в проекте, ни один пока не привязан к кадру.
  await expect(files.locator('.ed-assets__item')).toHaveCount(2, { timeout: 30_000 })
  await expect(files.locator('.ed-files__where').first()).toHaveText('ни в одном кадре')

  // Прикрепляем первый файл к главе (первый из доступных кадров) и проверяем подпись.
  const firstRow = files.locator('.ed-assets__item').first()
  await firstRow.getByRole('button', { name: 'прикрепить' }).click()
  const attachOptions = await frameOptions(firstRow)
  expect(attachOptions).toHaveLength(2) // глава и под-событие
  await firstRow.getByLabel(/Кадр для/).selectOption(attachOptions[0])
  await firstRow.getByRole('button', { name: 'Прикрепить', exact: true }).click()
  await expect(firstRow.locator('.ed-files__where')).toHaveText('01 Новая глава')

  // Теперь переносим тот же файл в под-событие. В выборе остаётся только под-событие:
  // в кадре, где файл уже лежит, переносить некуда — и это видно по списку вариантов.
  await firstRow.getByRole('button', { name: 'перенести' }).click()
  const moveOptions = await frameOptions(firstRow)
  expect(moveOptions).toHaveLength(1)
  await firstRow.getByLabel(/Кадр для/).selectOption(moveOptions[0])
  await firstRow.getByRole('button', { name: 'Перенести', exact: true }).click()

  await expect(firstRow.locator('.ed-files__where')).toHaveText('01.1 Новое подсобытие')
  // Файл остаётся в проекте: перенос — это не удаление.
  await expect(files.locator('.ed-assets__item')).toHaveCount(2)
})
