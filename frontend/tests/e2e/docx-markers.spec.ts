import { test, expect } from '@playwright/test'
import { apiHeaders, openEditorsTab, signIn } from './support'

/**
 * Маркеры DOCX — через интерфейс, как их ставит человек (0.92.2).
 *
 * Что проверяется здесь, а не в компонентных тестах: панель «Разметка DOCX» действительно
 * вставляет маркеры в текст кадра, сохранение доводит их до сервера, а в показе проекта
 * служебных строк не видно. Перевод маркеров в XML документа проверяют серверные тесты
 * (`backend/internal/transfer/docx_markers_test.go`) — здесь важен путь человека.
 */
test.setTimeout(180_000)

test('маркеры DOCX вставляются панелью, доезжают до сервера и не видны в показе', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Маркеры ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  const projectURL = page.url()
  expect(projectURL).toMatch(/\/projects\/[0-9a-f-]+$/)
  const projectId = projectURL.split('/').pop()

  // Кадр и текст — через интерфейс: текст кадра живёт в CRDT, и кадр, созданный запросом,
  // в браузере не появится.
  await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 60_000 })
  await openEditorsTab(page)
  const row = page.locator('.ed-row').first()
  await expect(row).toBeVisible({ timeout: 45_000 })
  await row.click()
  await page.getByPlaceholder('Заголовок события').fill('Глава')
  await page.locator('.ed-editor textarea').first().fill('Первый абзац главы.\n\nВторой абзац.')

  // Панель «Разметка DOCX»: две кнопки без шаблона — разрыв страницы и оглавление.
  await page.getByRole('button', { name: 'Открыть редактор Markdown' }).click()
  const editor = page.locator('.md-editor')
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: /Разметка DOCX/ }).click()
  await editor.getByRole('button', { name: 'разрыв страницы' }).click()
  await editor.getByRole('button', { name: 'оглавление' }).click()
  const text = await editor.getByLabel('Текст события в Markdown').inputValue()
  expect(text).toContain('<!-- sf:pagebreak -->')
  expect(text).toContain('<!-- sf:toc -->')
  // Каждый маркер — отдельной строкой: склеенный маркер сервер не разберёт.
  const markerLines = text.split('\n').filter((line) => line.trim().startsWith('<!-- sf:'))
  expect(markerLines).toHaveLength(2)
  await editor.getByRole('button', { name: 'Сохранить текст' }).click()

  /**
   * Два шага вместо одного (0.120.1).
   *
   * Ночной прогон 29.10 уронил этот сценарий: клик «Сохранить текст» прошёл, а маркеры до
   * `export.md` не доехали за минуту. Причин может быть две — сохранение не попало в документ
   * вкладки ИЛИ документ ещё не слился с сервером, — и старый разбор (`опрашивать экспорт») их не
   * различал: падение говорило «экспорт без маркеров» и ничего о том, где потерялось.
   *
   * Теперь сначала подтверждается документ ВКЛАДКИ (поле кадра — оно читает CRDT), и только потом
   * сервер. Если сломается сохранение, ошибка будет про редактор; если сервер, будет про слияние.
   */
  await editor.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => undefined)
  await expect(page.locator('.ed-editor textarea').first()).toContainText('<!-- sf:pagebreak -->', {
    timeout: 20_000,
  })
  // Значение поля кадра на момент разбора ошибки: видно, остались ли маркеры в документе вкладки.
  const markersInFrame = await page
    .locator('.ed-editor textarea')
    .first()
    .inputValue()
    .catch(() => 'поле не найдено')

  // Текст с маркерами доехал до сервера: в `.md` маркеры остаются исходником.
  const headers = await apiHeaders(page)
  let markdown = ''
  let lastStatus = 0
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/projects/${projectId}/export.md`, { headers })
        lastStatus = response.status()
        markdown = await response.text()
        return markdown.includes('<!-- sf:pagebreak -->') && markdown.includes('<!-- sf:toc -->')
      },
      // 120 с вместо 60 (0.120.1): слияние документа с сервером идёт своим темпом, и на
      // загруженном раннере минуты не хватило. Ждём терпеливо, но с внятным разбором ниже.
      { timeout: 120_000, intervals: [1000, 2000, 5000] },
    )
    .toBe(true)
    .catch((error) => {
      throw new Error(
        `${error.message}\nстатус export.md: ${lastStatus}\n` +
          `начало текста: ${markdown.slice(0, 400)}\n` +
          `маркеры в поле кадра: ${markersInFrame}`,
      )
    })

  // Скачивание в DOCX собирается (сам XML проверяют серверные тесты). Путь именно
  // `/export/docx` — отдельным сегментом, а не параметром формата: так ссылку скачивает браузер.
  const docx = await page.request.get(`/api/projects/${projectId}/export/docx`, { headers })
  expect(docx.status()).toBe(200)
  expect((await docx.body()).byteLength).toBeGreaterThan(1000)

  // В показе проекта служебных строк нет: маркеры маскируются до отрисовки Markdown.
  await page.locator('[data-project-tab="project"]').click()
  await expect(page.getByText('sf:pagebreak')).toHaveCount(0)
  await expect(page.getByText('Первый абзац главы.')).toBeVisible({ timeout: 30_000 })
})
