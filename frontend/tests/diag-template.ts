/**
 * Живая проверка шаблона проекта (0.85.0, docs/entity-types.md §3–5):
 *
 *   · GET /api/projects/{id}/template отдаёт типы с заготовками, карточки и настройки помощника;
 *   · повторное применение того же шаблона ничего не меняет («всё уже на месте») — идемпотентность;
 *   · POST /api/projects/from-template создаёт проект сразу с типами и карточками;
 *   · архив проекта содержит template.json;
 *   · интерфейс: заготовка типа подставляется в форму карточки, настройки проекта показывают
 *     блок «Шаблон проекта», кнопка скачивания отдаёт файл.
 *
 * Запуск: cd frontend && npx tsx tests/diag-template.ts
 * Снимки: _dev_shots/template-settings.png, template-prefill.png
 */
import { chromium, type APIRequestContext, type Page } from 'playwright'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots'

async function evalIn<T>(page: Page, body: string, arg?: unknown): Promise<T> {
  const code = `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`
  return (await page.evaluate(code)) as T
}

interface Template {
  version: number
  entity_types: Array<{ key: string; title: string; card_template?: { description?: string; aliases?: string[] } }>
  cards?: Array<{ name: string }>
  ai?: { role: string; generation: string; image_style: string }
}

interface Report {
  types_added: number
  types_updated: number
  cards_added: number
  cards_skipped?: Array<{ name: string; reason: string }>
  ai_updated: boolean
  changed: number
  message: string
}

async function api(request: APIRequestContext, token: string, path: string, init: Record<string, unknown> = {}) {
  const response = await request.fetch(`http://127.0.0.1:8181/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers as object ?? {}) },
  })
  return response
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`)
  })

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await evalIn<string>(
    page,
    `return JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken`,
  )
  const request = page.request

  // За собой убираем: прогоны создают проекты «Шаблон NNNNN», и без этого список проектов
  // разработчика зарастает мусором (каждый прогон добавлял по одному).
  const listRes = await api(request, token, '/projects')
  if (listRes.ok()) {
    const list = (await listRes.json()) as Array<{ id: string; title: string }>
    for (const item of list) {
      if (item.title.startsWith('Шаблон ')) {
        await api(request, token, `/projects/${item.id}`, { method: 'DELETE' })
        console.log(`удалён прошлый прогон: «${item.title}»`)
      }
    }
  }

  // 1. Шаблон проекта-образца.
  const templateRes = await api(request, token, `/projects/${PROJECT_ID}/template`)
  if (templateRes.status() !== 200) {
    problems.push(`GET /template: ${templateRes.status()}`)
  }
  const template = (await templateRes.json()) as Template
  const customType = template.entity_types.find((item) => !['character', 'place', 'theme'].includes(item.key))
  console.log(
    `шаблон: типов ${template.entity_types.length}, карточек ${template.cards?.length ?? 0}, ` +
      `роль «${template.ai?.role ?? ''}», генерация «${template.ai?.generation ?? ''}»`,
  )
  if (template.version !== 1) problems.push(`версия шаблона ${template.version}`)
  if (template.entity_types.length < 3) problems.push('в шаблоне нет стартовых типов')

  // 2. Идемпотентность: тот же шаблон в тот же проект ничего не меняет.
  const applyRes = await api(request, token, `/projects/${PROJECT_ID}/template`, {
    method: 'POST',
    data: template,
  })
  if (applyRes.status() !== 200) {
    problems.push(`POST /template: ${applyRes.status()} ${await applyRes.text()}`)
  }
  const firstReport = ((await applyRes.json()) as { report: Report }).report
  console.log(`повторное применение: ${JSON.stringify(firstReport)}`)
  if (firstReport.changed !== 0) {
    problems.push(`повтор шаблона изменил проект: ${firstReport.changed} изменений`)
  }
  if (!firstReport.message.includes('всё уже на месте')) {
    problems.push(`сообщение повтора: ${firstReport.message}`)
  }

  // 3. Новый проект по образцу.
  const title = `Шаблон ${Date.now().toString().slice(-5)}`
  const createRes = await api(request, token, '/projects/from-template', {
    method: 'POST',
    data: { title, description: '', template },
  })
  if (createRes.status() !== 201) {
    problems.push(`POST /projects/from-template: ${createRes.status()} ${await createRes.text()}`)
  }
  const created = (await createRes.json()) as { project: { id: string; title: string }; report: Report }
  console.log(`создан «${created.project.title}»: ${created.report.message}`)
  const expectedCards = template.cards?.length ?? 0
  if (created.report.cards_added !== expectedCards) {
    problems.push(
      `в новом проекте карточек ${created.report.cards_added}, в шаблоне ${expectedCards}`,
    )
  }
  if (createRes.ok()) {
    // Типы с ключами шаблона — включая свои: ключ не должен переименоваться в frakciya-2.
    const typesRes = await api(request, token, `/projects/${created.project.id}/entity-types`)
    const types = ((await typesRes.json()) as { types: Array<{ key: string; card_template?: { description?: string } }> }).types
    console.log(`типы нового проекта: ${types.map((item) => item.key).join(', ')}`)
    if (customType && !types.some((item) => item.key === customType.key)) {
      problems.push(`в новом проекте нет типа «${customType.key}»`)
    }
    if (customType?.card_template?.description) {
      const copied = types.find((item) => item.key === customType.key)
      if (copied?.card_template?.description !== customType.card_template.description) {
        problems.push('заготовка карточки не перенеслась в новый проект')
      }
    }
  }

  // 4. Архив содержит template.json.
  const exportRes = await api(request, token, `/projects/${PROJECT_ID}/export`)
  if (exportRes.status() !== 200) {
    problems.push(`экспорт: ${exportRes.status()}`)
  } else {
    const bytes = await exportRes.body()
    const hasTemplate = bytes.includes(Buffer.from('template.json'))
    console.log(`архив: ${Math.round(bytes.length / 1024)} КБ, template.json внутри: ${hasTemplate}`)
    if (!hasTemplate) problems.push('в архиве нет template.json')
  }

  // 5. Настройки проекта: блок шаблона и скачивание файлом.
  await page.goto(`${BASE}/projects/${PROJECT_ID}/settings`)
  const block = page.locator('[data-project-template]')
  await block.waitFor({ state: 'visible', timeout: 30_000 })
  await block.screenshot({ path: `${OUT}\\template-settings.png` })
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null)
  await page.locator('[data-template-download]').click()
  const download = await downloadPromise
  if (!download) {
    problems.push('кнопка «Скачать шаблон» не отдала файл')
  } else {
    console.log(`скачан файл: ${download.suggestedFilename()}`)
    const path = await download.path()
    if (path) {
      const fs = await import('node:fs/promises')
      const text = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(text) as Template
      if (parsed.entity_types.length !== template.entity_types.length && parsed.cards?.length !== template.cards?.length) {
        problems.push('скачанный шаблон не совпал с тем, что отдал API')
      }
    }
  }
  const sourceOptions = await page.locator('[data-template-source] option').count()
  console.log(`проектов-образцов в списке: ${sourceOptions - 1}`)

  // 6. Заготовка типа в интерфейсе: создаём тип с заготовкой и смотрим, что подставится.
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  await page.locator('[data-project-tab="relations"]').click()
  await page.locator('[data-relation-entities], [data-entities]').first().waitFor({ state: 'visible', timeout: 30_000 })
  const typeName = `Порт ${Date.now().toString().slice(-4)}`
  await page.selectOption('[data-entity-kind-select]', '__new_type__')
  await page.fill('[aria-label="Название нового типа"]', typeName)
  await page.fill('[data-entity-type-aliases]', 'порт, гавань')
  await page.fill('[data-entity-type-template]', '{{name}} — порт на северном берегу.')
  await page.click('[data-entity-type-add]')
  await page.waitForTimeout(1500)
  const typesRes = await api(request, token, `/projects/${PROJECT_ID}/entity-types`)
  const types = ((await typesRes.json()) as { types: Array<{ key: string; title: string; card_template?: { description?: string; aliases?: string[] } }> }).types
  const createdType = types.find((item) => item.title === typeName)
  if (!createdType) {
    problems.push(`тип «${typeName}» не создан через интерфейс`)
  } else {
    console.log(`создан тип ${createdType.key}: заготовка «${createdType.card_template?.description ?? ''}»`)
    if (createdType.card_template?.description !== '{{name}} — порт на северном берегу.') {
      problems.push('заготовка описания не сохранилась')
    }
    // Выбираем тип и вводим имя: описание должно подставиться с именем.
    await page.selectOption('[data-entity-kind-select]', createdType.key)
    await page.fill('[aria-label="Имя карточки"]', 'Северный порт')
    await page.waitForTimeout(400)
    const desc = await page.inputValue('[data-entity-desc-input]')
    const aliases = await page.inputValue('[aria-label="Алиасы карточки"]')
    console.log(`подстановка: описание «${desc}», алиасы «${aliases}»`)
    if (desc !== 'Северный порт — порт на северном берегу.') {
      problems.push(`описание не подставилось: «${desc}»`)
    }
    if (aliases !== 'порт, гавань') {
      problems.push(`алиасы заготовки не подставились: «${aliases}»`)
    }
    await page.locator('[data-relations]').screenshot({ path: `${OUT}\\template-prefill.png` })
    // За собой убираем: тип без карточек удаляется.
    await api(request, token, `/projects/${PROJECT_ID}/entity-types/${createdType.key}`, { method: 'DELETE' })
  }
  // Проект, созданный «по шаблону», в корзину: он нужен был только для проверки.
  if (createRes.ok()) {
    await api(request, token, `/projects/${created.project.id}`, { method: 'DELETE' })
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет')
}

await main()
