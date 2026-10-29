import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * Вход для сценариев e2e на чистой базе.
 *
 * Зачем общий помощник, а не копия в каждом файле. Администратора на пустой базе
 * регистрирует сценарий первой регистрации (`install.spec.ts`), остальные должны войти
 * ТОЙ ЖЕ учётной записью, иначе они честно пропускаются — и проверка, ради которой
 * файл написан, не выполняется вовсе (так и вышло с первым вариантом сценария
 * загрузки: в CI он пропускался бы всегда).
 *
 * Правила:
 *   * форма «Первый администратор» — регистрируем фиксированный адрес;
 *   * форма «Регистрация» (режим open) — регистрируем новый уникальный адрес;
 *   * иначе (заявки по email) — входим фиксированным адресом, а если его нет,
 *     в CI это ПРОВАЛ, а локально — пропуск сценария (`false`).
 *
 * Почему в CI провал, а не пропуск: пропуск выглядит зелёным, и именно так регрессия
 * «на чистой базе нет первого администратора» прожила незамеченной целый релиз —
 * пять e2e-сценариев вместо проверки рапортовали «skipped».
 */
const PASSWORD = 'hunter22!'

/** Адрес, который регистрирует первый сценарий и которым пользуются остальные. */
export const E2E_ADMIN_EMAIL = 'assistant.e2e@example.com'

export { PASSWORD }

/**
 * Открыть вкладку режима проекта (0.83.0).
 *
 * До 0.83.0 разделы «Редакторы» / «Связи» / «Версии» лежали друг под другом в одном длинном
 * потоке, и дерево кадров было видно сразу после создания первой главы. Теперь это вкладки, и
 * сценарий обязан её выбрать — иначе он честно не найдёт строк дерева. Если вкладок нет
 * (читатель, пустой проект), помощник молча ничего не делает.
 */
export async function openProjectTab(
  page: Page,
  tab: 'project' | 'editors' | 'relations' | 'versions',
): Promise<void> {
  const button = page.locator(`[data-project-tab="${tab}"]`)
  // Вкладки появляются, когда в проекте есть содержимое: после создания первой главы (в том
  // числе помощником) это происходит на несколько мгновений позже. Ждём их, а не пропускаем
  // клик молча — иначе сценарий падает на пустом дереве, и причина не видна.
  await button.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined)
  if ((await button.count()) === 0) return
  await button.click()
}

/** Частый случай: нужны строки дерева кадров — значит вкладка «Редакторы». */
export async function openEditorsTab(page: Page): Promise<void> {
  await openProjectTab(page, 'editors')
}

/**
 * Раскрыть группу карточек в «Связях проекта» (0.111.0).
 *
 * Зачем: с 0.111.0 группы по видам свёрнуты по умолчанию (отчёт «списки по группам лучше сразу
 * держать свернутыми»), поэтому карточки и их меню лежат внутри закрытого `details` — сценарий,
 * который кликает по карточке, обязан сначала раскрыть её вид, как это сделал бы человек. Раньше
 * сценарии этого не делали: группы были раскрыты, и проверка «карточка видна» проходила сама.
 */
export async function openEntityGroup(page: Page, kind: string): Promise<void> {
  const group = page.locator(`[data-entity-group="${kind}"]`)
  await group.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => undefined)
  if ((await group.count()) === 0) return
  if (await group.evaluate((node: HTMLDetailsElement) => node.open)) return
  await group.locator('summary').first().click()
  await expect(group).toHaveJSProperty('open', true)
}

/**
 * Токен текущей сессии для запросов из сценария (0.92.2).
 *
 * `page.request` — это HTTP-клиент Playwright: localStorage страницы он не видит и cookie тоже не
 * всегда (приложение хранит JWT в localStorage). Поэтому сценарий, которому нужен серверный ответ
 * (например, скачанный `.md` или `.docx`), берёт токен из состояния авторизации и передаёт его
 * сам — иначе проверка молча получила бы 401 и проверяла бы не то.
 */
export async function apiToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('skyfraze-auth') || '{}'
    const parsed = JSON.parse(raw) as { state?: { accessToken?: string } }
    return parsed.state?.accessToken ?? ''
  })
}

/** Заголовки для `page.request` с токеном сессии. */
export async function apiHeaders(page: Page): Promise<Record<string, string>> {
  const token = await apiToken(page)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function signIn(page: Page, email: string = E2E_ADMIN_EMAIL): Promise<boolean> {
  await page.goto('/register')
  const heading = await page.locator('h1').innerText()

  // Заголовок проверяем на обоих языках (0.116.0): интерфейс может быть переключён до входа, и
  // «First administrator» — такой же признак пустой инсталляции, как «Первый администратор».
  if (/Первый администратор|First administrator/i.test(heading)) {
    await register(page, email)
    return true
  }
  if (/Регистрация|Sign up|Registration/i.test(heading)) {
    // Режим open: заводим свой адрес, чтобы не зависеть от чужих данных на стенде.
    await register(page, `e2e+${Date.now()}@example.com`)
    return true
  }

  await page.goto('/login')
  // Селекторы по типу поля, а не по подписи (0.116.0): подпись зависит от языка интерфейса, и
  // сценарий с переключённым английским падал на «нет поля «пароль»». Тип поля от языка не
  // зависит, поэтому вход работает при любом выбранном языке — это и нужно проверять.
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()
  const ok = await page
    .waitForURL(/\/projects$/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

  if (!ok && process.env.CI) {
    throw new Error(
      `не удалось войти как ${email}: в CI это не «пропуск», а провал — сценарий за этой ` +
        'строкой проверяет именно то, ради чего написан. Скорее всего не сработала первая ' +
        'регистрация (install.spec.ts) или изменился пароль в support.ts.',
    )
  }
  return ok
}

/**
 * Помощник выключен на стенде — сценарий проверять нечего (0.109.0).
 *
 * До 0.109.0 в шести файлах стояла одна и та же строка: если в окне помощника написано
 * «Помощник выключен на этом стенде», сценарий помечался `skipped` и считался пройденным. На
 * dev-стенде это разумно (там помощника можно выключить), но у пропуска есть неприятное
 * свойство: он ВЫГЛЯДИТ зелёным. Стоит отвалиться `AI_ENABLED` или не подняться заглушке
 * провайдера — и восемь сценариев про помощника молча перестают проверять что-либо, а CI
 * остаётся зелёным. Ровно так уже было с входом на чистой базе: пять сценариев рапортовали
 * «skipped», а регрессии никто не видел.
 *
 * Поэтому поведение теперь зависит от стенда, как у `signIn`:
 *   * CI (или явный `E2E_REQUIRE_AI=1`) — ПРОВАЛ с объяснением, что именно поднять;
 *   * локально — пропуск, потому что локальный стенд человек собирает под себя.
 *
 * `panel` — окно помощника (`[data-assistant-panel]`); `scenario` — название сценария, чтобы из
 * сообщения об ошибке было видно, какая проверка не выполнилась.
 */
export async function gateAssistant(panel: Locator, scenario: string): Promise<void> {
  const off = panel.getByText('Помощник выключен на этом стенде')
  if (!(await off.isVisible().catch(() => false))) return
  if (process.env.CI || process.env.E2E_REQUIRE_AI === '1') {
    throw new Error(
      `помощник выключен на стенде, а сценарий «${scenario}» написан ради его проверки: ` +
        'включите AI_ENABLED и заглушку провайдера (frontend/tests/e2e/stub-ollama.mjs). ' +
        'В CI это провал, а не пропуск — пропуск выглядит зелёным.',
    )
  }
  test.skip(true, 'помощник выключен на стенде')
}

async function register(page: Page, email: string): Promise<void> {
  // По типам полей, а не по подписям: подписи зависят от языка интерфейса (0.116.0).
  await page.locator('input[type="text"], input:not([type])').first().fill('E2E User')
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(PASSWORD)
  await page.locator('button[type="submit"]').click()
  await expect(page).toHaveURL(/\/projects$/)
}
