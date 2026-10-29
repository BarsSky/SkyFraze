import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab, gateAssistant } from './support'

/**
 * Перенос кадра по дереву по подтверждению (0.109.0) — целиком через браузер.
 *
 * Зачем отдельный сценарий. Перенос — единственная правка помощника, которая меняет не
 * содержимое кадра, а его МЕСТО, и проверять её юнит-тестами бессмысленно: подпись «в верхний
 * уровень» можно нарисовать, ничего не перенеся, а дерево при этом останется прежним. Серверные
 * тесты (`move_proposals_integration_test.go`) доказывают, что до подтверждения проект не
 * меняется, а применение доезжает до документа; компонентные (`AssistantPanel.test.tsx`) — что
 * подпись и diff собираются по виду правки. Ни те, ни другие не отвечают на вопрос сценария:
 * человек ВИДИТ, откуда и куда переезжает кадр, а после «Применить» кадр действительно меняет
 * уровень В ДЕРЕВЕ и без перезагрузки страницы.
 *
 * Вложенный кадр готовим импортом Markdown, а не помощником: `POST /events` пишет только
 * таблицу событий, а дерево и стадия читают документ CRDT (на этом уже спотыкался аудит —
 * проект выглядел пустым). Импорт идёт тем же путём, что и помощник (`LiveDoc`), поэтому
 * документ и таблица согласованы. Вложенность задаёт каталог в имени файла (`Пролог/…`):
 * один файл — всегда одно событие, заголовки внутри него остаются текстом. Дальше вложенность
 * проверяется по `data-depth` строки дерева — это то, что видит человек, а не проекция в базе.
 *
 * Провайдер — заглушка `stub-ollama.mjs`: на слово «перенеси» она отдаёт вызов `move_event`
 * с `parent_id: ''`. Идентификатор кадра она берёт из вопроса, если он там есть (как это
 * сделала бы живая модель, взяв его из дерева в системном сообщении), — поэтому в вопросе
 * стоит настоящий uuid кадра, а не «первый кадр».
 */
test.setTimeout(180_000)

test('агент предлагает перенос кадра, а делает его человек', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Перенос ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
  const projectID = page.url().match(/\/projects\/([0-9a-f-]+)$/)?.[1] ?? ''
  expect(projectID).not.toBe('')

  // 1. Вложенный кадр. Вложенность задаёт КАТАЛОГ: один файл — одно событие (заголовки внутри
  //    него остаются текстом), а `Пролог/index.md` + `Пролог/01-Сцена первая.md` дают главу с
  //    кадром внутри. Так «Сцена первая» получает родителя, а значит перенос на верхний уровень
  //    что-то МЕНЯЕТ (переносить кадр, который уже в корне, — проверка ни о чём).
  //
  //    Запрос уходит ИЗ СТРАНИЦЫ, а не через `page.request`: вложенность держится на имени файла
  //    в заголовке части (`Пролог/index.md`), и собирать multipart браузерным `FormData` — ровно
  //    то, что делает интерфейс импорта. Через `page.request` тот же набор падал на сериализации
  //    (`apiRequestContext.post: stream.on is not a function`), то есть проверялся бы не тот путь.
  const imported = await page.evaluate(
    async ({ id, files }) => {
      const token = JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state?.accessToken ?? ''
      const form = new FormData()
      for (const file of files) {
        form.append('files', new Blob([file.body], { type: 'text/markdown' }), file.name)
      }
      const res = await fetch(`/api/projects/${id}/import/markdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
      return { status: res.status, text: (await res.text()).slice(0, 300) }
    },
    {
      id: projectID,
      files: [
        { name: 'Пролог/index.md', body: '# Пролог\n\nТекст главы.' },
        { name: 'Пролог/01-Сцена первая.md', body: '# Сцена первая\n\nТекст сцены.' },
      ],
    },
  )
  // 201 — так ручка отвечает на вставку («создано»), хотя проект существовал: вставляется
  // содержимое, а не проект.
  expect(imported.status, imported.text).toBe(201)

  // Документ приезжает в открытую вкладку слиянием; перезагрузка убирает вопрос «успело ли».
  await page.reload()
  await openEditorsTab(page)

  const frameRow = page.locator('.ed-row', { hasText: 'Сцена первая' })
  await expect(frameRow).toBeVisible({ timeout: 45_000 })
  const depthBefore = await frameRow.getAttribute('data-depth')
  // Кадр должен быть ВЛОЖЕН: если импорт положил его в корень, сценарий проверял бы перенос
  // «верхний уровень → верхний уровень», и зелёный результат ничего не значил бы.
  expect(Number(depthBefore)).toBeGreaterThan(0)
  const frameID = await frameRow.getAttribute('data-event-id')
  expect(frameID).toBeTruthy()

  const fab = page.locator('[data-assistant-fab]')
  const panel = page.locator('[data-assistant-panel]')
  await fab.click()
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'перенос кадра по дереву')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill(`Перенеси кадр ${frameID} на верхний уровень`)
  await panel.getByRole('button', { name: 'Спросить' }).click()

  // 2. Предложение читается как «откуда → куда»: человек подтверждает то, что прочитал.
  const proposals = panel.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })
  await expect(proposals).toContainText('Переместить кадр «Сцена первая» в верхний уровень')
  await expect(proposals).toContainText('место: Пролог → верхний уровень')

  // До подтверждения проект не менялся: кадр на прежнем уровне.
  await expect(frameRow).toHaveAttribute('data-depth', String(depthBefore))

  // 3. Применяем — кадр переезжает в корень, и это видно в дереве без перезагрузки страницы.
  await proposals.getByRole('button', { name: 'Применить' }).click()
  const applied = panel.locator('[data-assistant-applied]')
  await expect(applied).toBeVisible({ timeout: 30_000 })
  await expect(applied).toContainText('Кадр «Сцена первая» перемещён в верхний уровень')
  await expect(frameRow).toHaveAttribute('data-depth', '0', { timeout: 30_000 })

  // 4. «Вернуть в прежнюю главу» возвращает ровно место: уровень прежний, текст кадра цел.
  //    Кнопка подписана «главу», а не «прежний текст», — правка возвращается в состояние
  //    «ждёт решения», как у остальных видов правок.
  await applied.getByRole('button', { name: 'Вернуть в прежнюю главу' }).click()
  await expect(panel.locator('[data-assistant-proposals]')).toBeVisible({ timeout: 30_000 })
  await expect(frameRow).toHaveAttribute('data-depth', String(depthBefore), { timeout: 30_000 })
})
