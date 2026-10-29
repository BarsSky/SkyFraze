import { test, expect } from '@playwright/test'
import { signIn, openEditorsTab, gateAssistant } from './support'

/**
 * Дата кадра по подтверждению (0.106.0) — целиком через браузер.
 *
 * Почему отдельный сценарий, а не ещё один блок в `assistant-edit.spec.ts`. Дата устроена
 * иначе, чем текст: она живёт не в `Y.Text`, а отдельным ключом карты события, показывается
 * не в `textarea`, а в `<input type="date">`, и «Вернуть» у неё своё — «Вернуть прежнюю дату».
 * Серверные тесты (`date_proposals_integration_test.go`) доказывают, что проект не меняется
 * до подтверждения и что применение доезжает до документа, а компонентные
 * (`AssistantPanel.test.tsx`) — что подпись и diff собираются по виду правки. Ни те, ни другие
 * не отвечают на вопрос, ради которого сценарий и написан: человек ВИДИТ предложение с
 * «было → станет», поле даты в редакторе до подтверждения остаётся пустым, а после
 * «Применить» дата появляется в поле БЕЗ перезагрузки страницы.
 *
 * Последнее — не формальность. Правку делает сервер, и до вкладки она доезжает слиянием
 * документа (`reloadFromServer({ quiet: true })`); если бы ключ даты в это слияние не попадал,
 * «Применить» выглядело бы рабочим (кнопки нажимаются, отметка в окне помощника есть), а
 * в редакторе стояла бы прежняя пустая дата. Именно так уже было с версиями: сервер отдавал
 * `revision`, а клиент ждал `version`.
 *
 * Провайдер — заглушка `stub-ollama.mjs`. На просьбу, где есть слово «дату», она отдаёт
 * вызов `update_event_date` с датой `2026-03-05` для первого кадра из дерева в системном
 * сообщении — то есть ровно то, что сделала бы настоящая модель: ПРЕДЛОЖИЛА, а не поставила.
 */
test.setTimeout(180_000)

test('агент предлагает дату кадра, а ставит её человек', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  const title = `Дата ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)

  const fab = page.locator('[data-assistant-fab]')
  const panel = page.locator('[data-assistant-panel]')

  // 1. Сначала нужен кадр: предлагать дату нечему, пока в проекте ничего нет. Главу создаём
  //    помощником — так сценарий заодно проверяет, что дерево после его ответа действительно
  //    появилось, а не только «Создал главу» в переписке.
  await fab.click()
  await expect(panel).toBeVisible()
  await gateAssistant(panel, 'дата кадра по подтверждению')
  const input = panel.getByLabel('Сообщение помощнику')
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Добавь главу «Пролог» с описанием начала истории')
  await panel.getByRole('button', { name: 'Спросить' }).click()
  await expect(panel.getByText('Создал главу «Пролог».')).toBeVisible({ timeout: 90_000 })

  // Окно помощника закрываем — как это сделал бы человек. Дальше нужен редактор кадра, а окно
  // помощника висит поверх проекта в правом нижнем углу. История при закрытии не теряется
  // (окно не размонтируется, `AssistantDock`), поэтому второй вопрос продолжит ту же беседу.
  await fab.click()
  await expect(panel).toBeHidden()

  // 2. Кадр выбираем в дереве сами, а не полагаемся на «сам выбрался»: проверка поля даты
  //    имеет смысл только тогда, когда в редакторе открыт именно «Пролог». Заодно убеждаемся,
  //    что даты у кадра нет вовсе — значит, «без даты» в предложении ниже означает пустое
  //    поле, а не «дата есть, но помощнику её не показали».
  await openEditorsTab(page)
  const chapterRow = page.locator('.ed-row--chapter', { hasText: 'Пролог' }).first()
  await expect(chapterRow).toBeVisible({ timeout: 45_000 })
  await chapterRow.click()
  const dateInput = page.locator('.ed-form input[type="date"]').first()
  await expect(dateInput).toHaveValue('', { timeout: 30_000 })

  // 3. Просим дату. Слово «дату» в вопросе — то, по чему заглушка (как и живая модель)
  //    отличает эту просьбу от «перепиши»: ответ должен быть вызовом `update_event_date`,
  //    то есть ПРЕДЛОЖЕНИЕМ, а не записью в документ.
  await fab.click()
  await expect(panel).toBeVisible()
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill('Поставь этому кадру дату 5 марта')
  await panel.getByRole('button', { name: 'Спросить' }).click()

  const proposals = panel.locator('[data-assistant-proposals]')
  await expect(proposals).toBeVisible({ timeout: 90_000 })
  // Подпись отличает правку даты от перезаписи текста: человек подтверждает то, что прочитал.
  await expect(proposals).toContainText('Поменять дату кадра «Пролог»')
  // Дата показана «было → станет» в том же виде, в каком она стоит в поле редактора
  // (YYYY-MM-DD): иначе человек сверял бы «5 марта» с «2026-03-05» в другом формате.
  await expect(proposals).toContainText('дата: без даты → 2026-03-05')

  // Предложение — не изменение: блока «Изменения в проекте» быть не должно. Проверка с
  // «ожиданием» не случайно: предыдущий ответ (создание главы) оставил этот блок на экране, и
  // он должен исчезнуть, как только придёт итог второго ответа со своим пустым списком. Так
  // проверяется и то, что сервер не выдаёт дату за уже сделанное изменение.
  await expect(panel.locator('[data-assistant-changes]')).toHaveCount(0, { timeout: 30_000 })

  // Главное до подтверждения: проект НЕ менялся — поле даты в редакторе по-прежнему пустое.
  await expect(dateInput).toHaveValue('')

  // 4. Применяем — теперь проект меняется, и это видно человеку сразу, без перезагрузки:
  //    «было» в предложении стало настоящей датой кадра.
  await proposals.getByRole('button', { name: 'Применить' }).click()
  const applied = panel.locator('[data-assistant-applied]')
  await expect(applied).toBeVisible({ timeout: 30_000 })
  await expect(applied).toContainText('Дата кадра «Пролог» изменена')
  await expect(dateInput).toHaveValue('2026-03-05', { timeout: 30_000 })

  // 5. «Вернуть прежнюю дату» возвращает ровно дату и ничего кроме неё: поле снова пустое.
  //    Кнопка подписана «дату», а не «прежний текст» — возврат не должен трогать текст кадра,
  //    и правка возвращается в состояние «ждёт решения», как у остальных видов правок.
  await applied.getByRole('button', { name: 'Вернуть прежнюю дату' }).click()
  await expect(panel.locator('[data-assistant-proposals]')).toBeVisible({ timeout: 30_000 })
  await expect(dateInput).toHaveValue('', { timeout: 30_000 })
})
