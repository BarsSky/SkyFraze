/**
 * Живая проверка справки и ПРИМЕРА шаблона DOCX (0.94.0).
 *
 * Главный вопрос был «с чего вообще начать»: человек видел только поле загрузки. Теперь есть
 * справка (что положить в шаблон, что воспринимается из текста, как называются стили) и готовый
 * пример .docx.
 *
 * Проверяем не текст, а КРУГ: скачиваем пример с сервера, загружаем его обратно как шаблон — и
 * сервер обязан принять его без предупреждений (плейсхолдер найден, карта стилей полная). Если
 * пример не принялся бы, он был бы хуже отсутствия примера. В конце диагностический шаблон
 * удаляется, так что стенд не меняется.
 *
 * Запуск: cd frontend && npx tsx tests/diag-docx-help.ts
 */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots\\docx-sample-example.docx'

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

  // 1. Пример скачивается и это настоящий .docx (zip: сигнатура PK).
  const sample = await page.request.get(`${API}/api/projects/${PROJECT_ID}/docx-templates/sample`, { headers })
  const bytes = await sample.body()
  await writeFile(OUT, bytes)
  console.log(`пример: ${sample.status()}, ${bytes.length} байт → ${OUT}`)
  if (sample.status() !== 200) problems.push(`пример: ${sample.status()}`)
  if (bytes.length < 1000) problems.push('пример подозрительно маленький')
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) problems.push('пример не zip (нет сигнатуры PK)')
  const disposition = sample.headers()['content-disposition'] ?? ''
  if (!disposition.includes('skyfraze-template-example.docx')) {
    problems.push(`имя файла примера не задано: ${disposition}`)
  }

  // 2. Круг: пример принимается как шаблон, без предупреждений.
  const name = `пример диагностики ${Date.now().toString().slice(-4)}`
  const upload = await page.request.post(`${API}/api/projects/${PROJECT_ID}/docx-templates`, {
    headers,
    multipart: {
      name,
      file: {
        name: 'skyfraze-template-example.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: bytes,
      },
    },
  })
  if (upload.status() !== 201) {
    problems.push(`пример не принят шаблоном: ${upload.status()} ${await upload.text()}`)
  } else {
    const body = (await upload.json()) as {
      template: { id: string; report: { has_placeholder: boolean; mapping: Record<string, string>; warnings?: string[] } }
    }
    const report = body.template.report
    console.log(`принят: плейсхолдер ${report.has_placeholder}, карта ${Object.keys(report.mapping).length} стилей, предупреждений ${report.warnings?.length ?? 0}`)
    if (!report.has_placeholder) problems.push('в примере не найден {{content}}')
    for (const key of ['title', 'heading1', 'heading2', 'heading3', 'quote', 'code', 'date', 'list']) {
      if (!report.mapping[key]) problems.push(`в примере не сопоставлен стиль «${key}»`)
    }
    if ((report.warnings?.length ?? 0) > 0) problems.push(`у примера есть предупреждения: ${report.warnings!.join('; ')}`)
    // Убираем за собой: пример — не рабочий шаблон проекта.
    await page.request.delete(`${API}/api/projects/${PROJECT_ID}/docx-templates/${body.template.id}`, { headers })
    console.log('диагностический шаблон удалён')
  }

  // 3. Справка в настройках: открывается кнопкой и говорит то, что нужно.
  await page.goto(`${BASE}/projects/${PROJECT_ID}/settings`)
  const openHelp = page.getByRole('button', { name: 'Как сделать шаблон' })
  await openHelp.waitFor({ state: 'visible', timeout: 20_000 })
  await openHelp.click()
  const dialog = page.getByRole('dialog', { name: /Справка по шаблону DOCX/ })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await dialog.getByText('Что берётся из текста').waitFor({ state: 'visible', timeout: 10_000 })
  await dialog.getByText('<!-- sf:pagebreak -->').waitFor({ state: 'visible', timeout: 10_000 })
  // Прокрутка справки внутри окна: длинный текст не должен уезжать за экран.
  const scroll = await dialog.locator('.docx-help__body').evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
  }))
  console.log(`справка: текст ${scroll.scrollHeight} px в окне ${scroll.clientHeight} px, overflow ${scroll.overflowY}`)
  if (scroll.overflowY !== 'auto') problems.push(`справка не прокручивается: ${scroll.overflowY}`)
  await page.screenshot({ path: '..\\_dev_shots\\docx-help-settings.png' })
  await dialog.getByRole('button', { name: 'Закрыть справку' }).click()

  // 4. Справка доступна и из панели «Разметка DOCX» в редакторе — там, где ставят маркеры.
  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  const editorsTab = page.locator('[data-project-tab="editors"]')
  await editorsTab.waitFor({ state: 'visible', timeout: 30_000 })
  await editorsTab.click()
  const row = page.locator('.ed-row').first()
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  await row.click()
  await page.getByRole('button', { name: 'Открыть редактор Markdown' }).click()
  const editor = page.locator('.md-editor')
  await editor.waitFor({ state: 'visible', timeout: 20_000 })
  await editor.getByRole('button', { name: /Разметка DOCX/ }).click()
  await editor.getByRole('button', { name: 'справка' }).click()
  await page.getByRole('dialog', { name: /Справка по шаблону DOCX/ }).waitFor({ state: 'visible', timeout: 10_000 })
  console.log('справка открывается и из редактора')
  await page.screenshot({ path: '..\\_dev_shots\\docx-help-editor.png' })

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('проблемы: нет; снимки: docx-help-settings.png, docx-help-editor.png')
}

await main()
