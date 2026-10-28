/**
 * Живая проверка шаблонов оформления DOCX (0.91.0, docs/docx-template.md).
 *
 * Проверяем всю цепочку на живом стенде: загрузка .docx, отчёт разбора (плейсхолдер, карта
 * стилей), активация, и то, что скачивание идёт ЧЕРЕЗ шаблон — по заголовку ответа
 * `X-Skyfraze-Docx-Template: custom`. Сам файл сохраняется рядом, чтобы проверить глазами:
 * титул шаблона на месте, плейсхолдера нет, текст проекта вставлен.
 *
 * Шаблон берётся из файла (по умолчанию `_dev_shots/template.docx`): собрать настоящий DOCX
 * скриптом без библиотеки zip нельзя, а проверять надо на реальном файле. Если файла нет —
 * скрипт говорит об этом и выходит, а не делает вид, что проверил.
 *
 * Запуск: cd frontend && npx tsx tests/diag-docx-template.ts
 */
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const TEMPLATE = process.env.DOCX_TEMPLATE ?? '..\\_dev_shots\\template.docx'
const OUT = '..\\_dev_shots\\docx-template-export.docx'

async function main() {
  if (!existsSync(TEMPLATE)) {
    console.log(`нет файла шаблона ${TEMPLATE} — соберите его и повторите (см. docs/docx-template.md)`)
    process.exitCode = 0
    return
  }
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))

  await page.goto(`${BASE}/login`)
  await page.getByPlaceholder('email').fill(EMAIL)
  await page.getByPlaceholder('пароль').fill(PASSWORD)
  await page.getByRole('button', { name: /Войти/ }).click()
  await page.waitForURL(/\/projects$/, { timeout: 20_000 })
  const token = await page.evaluate(
    `(async () => JSON.parse(localStorage.getItem('skyfraze-auth') || '{}').state.accessToken)()`,
  )
  const headers = { Authorization: `Bearer ${token}` }
  const data = await readFile(TEMPLATE)
  const name = `диагностика ${Date.now().toString().slice(-4)}`
  const before = (await (await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/docx-templates`, { headers })).json()) as {
    templates: Array<{ id: string; name: string; is_active: boolean }>
  }
  const hadTemplates = before.templates.length > 0

  // 1. Загрузка и отчёт разбора.
  const upload = await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/docx-templates`, {
    method: 'POST',
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
    problems.push(`загрузка шаблона: ${upload.status()} ${(await upload.text()).slice(0, 200)}`)
  } else {
    const body = (await upload.json()) as {
      template: {
        id: string
        is_active: boolean
        report: { has_placeholder: boolean; mapping: Record<string, string>; warnings?: string[] }
      }
    }
    const report = body.template.report
    console.log(`загружен «${name}»: плейсхолдер ${report.has_placeholder}, карта ${JSON.stringify(report.mapping)}`)
    if (!report.has_placeholder) problems.push('плейсхолдер не найден в шаблоне')
    if (!report.mapping.heading1) problems.push('в карте нет стиля для глав (heading1)')
    if ((report.warnings ?? []).length > 0) {
      console.log(`предупреждений отчёта: ${report.warnings!.length} (это норма для неполного шаблона)`)
    }
    if (!body.template.is_active && !hadTemplates) {
      // Первый шаблон проекта становится активным сам; если шаблон уже был — активным остаётся
      // прежний, и это правильно (переключение — отдельным действием).
      problems.push('первый шаблон не стал активным')
    }
  }

  // 2. Скачивание идёт через шаблон.
  const exportRes = await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/export/docx`, { headers })
  const mode = exportRes.headers()['x-skyfraze-docx-template'] ?? ''
  const bytes = await exportRes.body()
  await writeFile(OUT, bytes)
  console.log(`экспорт: ${exportRes.status()}, оформление «${mode || 'нет заголовка'}», ${bytes.length} байт`)
  if (exportRes.status() !== 200) problems.push(`экспорт: ${exportRes.status()}`)
  if (mode !== 'custom') problems.push(`оформление «${mode || 'нет'}», ожидалось custom`)
  if (bytes.length === 0) problems.push('экспорт пустой')

  // 3. Убираем за собой диагностический шаблон.
  const list = (await (await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/docx-templates`, { headers })).json()) as {
    templates: Array<{ id: string; name: string }>
  }
  const created = list.templates.find((item) => item.name === name)
  if (created) {
    await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/docx-templates/${created.id}`, {
      method: 'DELETE',
      headers,
    })
    console.log('диагностический шаблон удалён')
  }

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`проблемы: нет; файл для проверки глазами: ${OUT}`)
}

await main()
