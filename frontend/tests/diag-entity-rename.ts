/**
 * Живая проверка переименования карточки (0.97.4).
 *
 * Упоминания ищутся по имени и алиасам, поэтому смена имени без старого имени в алиасах молча
 * рвёт все связи карточки с кадрами: в тексте «Анна», а карточка уже «Аня», и счётчики панели
 * обнуляются. Проверяем числами: до переименования «1 кадр · 2 упоминания», после — те же два
 * упоминания, прежнее имя в алиасах, и примечание, которое это объясняет. Затем обратный случай:
 * имя, которого в тексте нет, в алиасы не попадает и счётчики честно обнуляются.
 *
 * Проект, кадр и карточка создаются и удаляются скриптом — стенд не меняется.
 * Запуск: cd frontend && npx tsx tests/diag-entity-rename.ts
 */
import { chromium } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'

/** Два упоминания «Анна» в одном кадре: счётчик покажет «1 кадр · 2 упоминания». */
const BODY = 'Анна вошла в дом. Анна долго ждала.'
const NAME = 'Анна'
const RENAMED = 'Аня'
/** Имя, которого в тексте нет — для обратного случая (карточка, которую в тексте не называли). */
const QUIET = 'Письмо'
const QUIET_RENAMED = 'Письмецо'
/** Ещё одно отсутствующее в тексте имя: проверка, что оно НЕ попадёт в алиасы. */
const ABSENT = 'Анюта'

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }

  const created = await (await page.request.post(`${API}/api/projects`, {
    headers,
    data: { title: 'Диагностика переименования', description: '' },
  })).json()
  const projectId: string = created.project?.id ?? created.id

  /** Открыть вкладку «Связи» и раскрыть блок карточек. */
  const openRelations = async () => {
    const tab = page.locator('[data-project-tab="relations"]')
    await tab.waitFor({ state: 'visible', timeout: 30_000 })
    await tab.click()
    const panel = page.locator('details.ent')
    await panel.waitFor({ state: 'attached', timeout: 20_000 })
    if (!(await panel.evaluate((node: HTMLDetailsElement) => node.open))) {
      await panel.locator('summary').first().click()
    }
    await page.locator('[data-entities-list]').waitFor({ state: 'visible', timeout: 20_000 })
  }

  /** Переименовать карточку через форму правки. */
  const rename = async (from: string, to: string) => {
    await page.getByLabel(`Изменить карточку ${from}`).click()
    const input = page.getByLabel(`Имя карточки ${from}`)
    await input.fill(to)
    await page.getByRole('button', { name: 'Сохранить' }).click()
    const note = page.locator('[data-entities-note]')
    await note.waitFor({ state: 'visible', timeout: 20_000 })
    return (await note.innerText()).replace(/\s+/g, ' ').trim()
  }

  try {
    // Текст кадра — через интерфейс: он живёт в CRDT, а не в базе строкой.
    await page.goto(`${BASE}/projects/${projectId}`)
    await page.getByRole('button', { name: /Добавить первую главу/ }).click({ timeout: 30_000 })
    const editors = page.locator('[data-project-tab="editors"]')
    await editors.waitFor({ state: 'visible', timeout: 30_000 })
    await editors.click()
    const row = page.locator('.ed-row').first()
    await row.waitFor({ state: 'visible', timeout: 45_000 })
    await row.click()
    const bodyArea = page.locator('.ed-editor textarea').first()
    await bodyArea.fill(BODY)
    // Дать сохранению (debounce 300 мс) уехать на сервер.
    await page.waitForTimeout(1200)

    const card = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
      headers,
      data: { name: NAME, kind: 'character' },
    })
    if (card.status() !== 201) problems.push(`карточка «${NAME}»: ${card.status()}`)
    // Вторая карточка — её имени в тексте нет: на ней проверяется обратный случай.
    const quiet = await page.request.post(`${API}/api/projects/${projectId}/entities`, {
      headers,
      data: { name: QUIET, kind: 'theme' },
    })
    if (quiet.status() !== 201) problems.push(`карточка «${QUIET}»: ${quiet.status()}`)

    await page.reload()
    await openRelations()
    const usage = page.locator('[data-entity-usage]')
    await usage.first().waitFor({ state: 'visible', timeout: 20_000 })
    const before = (await usage.first().innerText()).trim()
    console.log(`до переименования: «${before}»`)
    if (before !== '1 кадр · 2 упоминания') {
      problems.push(`до переименования ожидалось «1 кадр · 2 упоминания», а показано «${before}»`)
    }

    // 1. Переименование при имени, которое есть в тексте: имя остаётся алиасом.
    const keptNote = await rename(NAME, RENAMED)
    console.log(`примечание: ${keptNote}`)
    if (!keptNote.includes('Прежнее имя «Анна» оставлено в алиасах')) {
      problems.push(`примечание не объясняет сохранение имени: «${keptNote}»`)
    }
    if (!keptNote.includes('встречается 2 раза')) {
      problems.push(`примечание не называет число вхождений: «${keptNote}»`)
    }
    await page.reload()
    await openRelations()
    const cardRow = page.locator('[data-entity-kind]').first()
    const after = (await cardRow.locator('[data-entity-usage]').innerText()).trim()
    console.log(`после переименования: имя «${(await cardRow.locator('.ent__name').innerText()).trim()}», связь «${after}»`)
    if (after !== before) problems.push(`связи потерялись при переименовании: «${before}» → «${after}»`)
    const aliases = (await cardRow.locator('.ent__aliases').innerText()).trim()
    if (!aliases.includes('Анна')) problems.push(`прежнее имя не в алиасах: «${aliases}»`)

    // 2. Повторное переименование: прежние имена в алиасах остаются, связи не рвутся.
    const twiceNote = await rename(RENAMED, ABSENT)
    console.log(`примечание: ${twiceNote}`)
    await page.reload()
    await openRelations()
    const mainRow = page.locator('[data-entity-kind]').first()
    const stillThere = (await mainRow.locator('[data-entity-usage]').innerText()).trim()
    const mainAliases = (await mainRow.locator('.ent__aliases').innerText()).trim()
    console.log(`после второго переименования: имя «${(await mainRow.locator('.ent__name').innerText()).trim()}», связь «${stillThere}», алиасы «${mainAliases}»`)
    if (stillThere !== before) {
      problems.push(`второе переименование потеряло связи: «${before}» → «${stillThere}»`)
    }
    if (!mainAliases.includes('Анна')) problems.push(`алиас «Анна» потерялся: «${mainAliases}»`)

    // 3. Обратный случай: карточки нет в тексте — алиасы не трогаем, примечание обычное.
    const quietRow = page.locator('[data-entity-kind="theme"]').first()
    const quietUsageBefore = (await quietRow.locator('[data-entity-usage]').innerText()).trim()
    if (quietUsageBefore !== 'пока не упоминается') {
      problems.push(`у карточки без упоминаний ожидалось «пока не упоминается», а показано «${quietUsageBefore}»`)
    }
    const plainNote = await rename(QUIET, QUIET_RENAMED)
    console.log(`примечание: ${plainNote}`)
    if (plainNote.includes('оставлено в алиасах')) {
      problems.push(`алиас добавлен без причины: «${plainNote}»`)
    }
    await page.reload()
    await openRelations()
    const quietAfter = page.locator('[data-entity-kind="theme"]').first()
    const quietName = (await quietAfter.locator('.ent__name').innerText()).trim()
    console.log(`карточка без упоминаний после переименования: «${quietName}»`)
    if (quietName !== QUIET_RENAMED) problems.push(`имя не изменилось: «${quietName}»`)
    if ((await quietAfter.locator('.ent__aliases').count()) > 0) {
      problems.push('у карточки без упоминаний появились алиасы')
    }
    await page.screenshot({ path: '..\\_dev_shots\\entity-rename.png' })
  } finally {
    const removed = await page.request.delete(`${API}/api/projects/${projectId}`, { headers })
    console.log(`уборка: проект удалён (${removed.status()})`)
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимок: entity-rename.png')
}

await main()
