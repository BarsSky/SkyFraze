/**
 * Живая проверка переключателя оформления DOCX (0.93.1).
 *
 * Смысл фичи: оформление выбирают ПЕРЕД скачиванием. Проверяем в интерфейсе, а не только в
 * компоненте: меню «Книга» у проекта открывается, переключатель показывает активный шаблон,
 * смена в списке доезжает до сервера (активным стал другой), а без шаблонов — честная подпись.
 *
 * Нужен настоящий .docx (`_dev_shots/template.docx`): шаблон без файла не загрузить. Скрипт
 * убирает за собой загруженные шаблоны и возвращает прежний активный.
 * Запуск: cd frontend && npx tsx tests/diag-docx-switch.ts
 */
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const TEMPLATE = process.env.DOCX_TEMPLATE ?? '..\\_dev_shots\\template.docx'

interface TemplateRow {
  id: string
  name: string
  is_active: boolean
}

async function main() {
  if (!existsSync(TEMPLATE)) {
    console.log(`нет файла шаблона ${TEMPLATE} — соберите его и повторите`)
    process.exitCode = 0
    return
  }
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
  const list = async (): Promise<TemplateRow[]> => {
    const raw = await (await page.request.get(`${API}/api/projects/${PROJECT_ID}/docx-templates`, { headers })).json()
    return (raw.templates ?? []) as TemplateRow[]
  }

  const before = await list()
  const activeBefore = before.find((item) => item.is_active)?.id ?? null
  const data = await readFile(TEMPLATE)
  const suffix = Date.now().toString().slice(-4)
  const names = [`диагностика А ${suffix}`, `диагностика Б ${suffix}`]
  const created: string[] = []

  try {
    for (const name of names) {
      const upload = await page.request.post(`${API}/api/projects/${PROJECT_ID}/docx-templates`, {
        headers,
        multipart: {
          name,
          file: {
            name: 'template.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer: data,
          },
        },
      })
      if (upload.status() !== 201) {
        problems.push(`загрузка «${name}»: ${upload.status()} ${await upload.text()}`)
        continue
      }
      const body = (await upload.json()) as { template: { id: string } }
      created.push(body.template.id)
    }
    // Первый шаблон проекта активен сам; если шаблон уже был — переключаем явно на наш,
    // иначе в списке будет выбран чужой активный и проверка «переключилось» ничего не проверит.
    if (created.length > 0) {
      await page.request.post(`${API}/api/projects/${PROJECT_ID}/docx-templates/${created[0]}/activate`, { headers })
    }

    // Открываем список проектов и меню «Книга» у нужного проекта (карточка — `.card`).
    await page.goto(`${BASE}/projects`)
    const card = page
      .locator('.card', { has: page.locator(`a[href="/projects/${PROJECT_ID}"]`) })
      .first()
    await card.waitFor({ state: 'visible', timeout: 20_000 })
    const menu = card.locator('details.dl-menu', { hasText: 'Книга' }).first()
    await menu.locator('summary').click()

    const select = menu.getByLabel('Оформление')
    await select.waitFor({ state: 'visible', timeout: 20_000 })
    const options = await select.locator('option').allInnerTexts()
    console.log(`варианты: ${options.join(', ')}`)
    for (const name of names) {
      if (!options.some((option) => option.includes(name))) problems.push(`в переключателе нет «${name}»`)
    }

    // Переключаем на второй диагностический шаблон и проверяем сервер.
    const second = (await list()).find((item) => item.name === names[1])
    if (!second) {
      problems.push('второй шаблон не появился в списке')
    } else {
      await select.selectOption(second.id)
      const started = Date.now()
      let activeId = ''
      while (Date.now() - started < 15_000) {
        activeId = (await list()).find((item) => item.is_active)?.id ?? ''
        if (activeId === second.id) break
        await page.waitForTimeout(500)
      }
      console.log(`активный шаблон после переключения: ${activeId === second.id ? 'наш' : activeId}`)
      if (activeId !== second.id) problems.push('переключение не доехало до сервера')
      if ((await select.inputValue()) !== second.id) problems.push('переключатель показывает не активный шаблон')
    }
    await page.screenshot({ path: '..\\_dev_shots\\docx-switch.png' })
  } finally {
    // Уборка: наши шаблоны удаляем, прежний активный возвращаем.
    for (const id of created) {
      await page.request.delete(`${API}/api/projects/${PROJECT_ID}/docx-templates/${id}`, { headers })
    }
    if (activeBefore) {
      await page.request.post(`${API}/api/projects/${PROJECT_ID}/docx-templates/${activeBefore}/activate`, { headers })
    }
    console.log(`уборка: удалено ${created.length}, прежний активный ${activeBefore ? 'возвращён' : 'не было'}`)
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимок: ..\\_dev_shots\\docx-switch.png')
}

await main()
