/**
 * Живая проверка маркеров DOCX (0.92.0, docs/docx-template.md §3).
 *
 * Проверяем весь путь человека, а не только код: в редакторе кадра открыть «Разметку DOCX»,
 * вставить маркер, сохранить текст — и убедиться, что сервер уже видит маркер (выгрузка `.md`
 * хранит его как исходник) и отдаёт `.docx`, в котором маркер стал разрывом страницы и полем
 * оглавления.
 *
 * Почему ждём именно `.md`: правка идёт через CRDT и проецируется на сервер отложенно, а `.md` —
 * открытый текст, в котором маркер видно глазами. Ждать «сколько-то секунд» и надеяться — это то,
 * из-за чего такая проверка врёт: она зелёная, а маркера на сервере нет.
 *
 * Текст кадра меняется по-настоящему, поэтому в конце исходный текст возвращается на место.
 * Текст в `.docx` сжат внутри zip — распаковка отдельным шагом, скрипт печатает путь к файлу.
 *
 * Запуск: cd frontend && npx tsx tests/diag-docx-markers.ts
 */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:5173'
const API = process.env.API_URL ?? 'http://127.0.0.1:8181'
const EMAIL = process.env.VISUAL_EMAIL ?? 'dev.check@example.com'
const PASSWORD = 'hunter22!'
const PROJECT_ID = process.env.PROJECT_ID ?? '167edf2e-876a-4ef2-bd04-155efb648343'
const OUT = '..\\_dev_shots\\docx-markers-export.docx'

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
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
  const markdown = async () => {
    // `export.md` — тот же исходник, что человек скачивает в Markdown: маркеры в нём остаются
    // (их вырезают только EPUB и DOCX), поэтому по нему и видно, доехала ли правка до сервера.
    const response = await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/export.md`, { headers })
    return response.body().then((data) => data.toString('utf8'))
  }
  const docx = async () => {
    const response = await page.request.fetch(`${API}/api/projects/${PROJECT_ID}/export/docx`, { headers })
    return { status: response.status(), bytes: await response.body() }
  }
  /** Дождаться, пока сервер увидит маркер (или перестанет его видеть при восстановлении). */
  const waitServer = async (want: boolean, label: string) => {
    const started = Date.now()
    while (Date.now() - started < 40_000) {
      const text = await markdown()
      const has = text.includes('<!-- sf:pagebreak -->')
      if (has === want) {
        console.log(`${label}: сервер ${want ? 'увидел' : 'отпустил'} маркер за ${Date.now() - started} мс`)
        return true
      }
      await page.waitForTimeout(1000)
    }
    problems.push(`${label}: сервер так и не ${want ? 'увидел' : 'отпустил'} маркер за 40 с`)
    return false
  }

  await page.goto(`${BASE}/projects/${PROJECT_ID}`)
  const editorsTab = page.locator('[data-project-tab="editors"]')
  await editorsTab.waitFor({ state: 'visible', timeout: 20_000 })
  await editorsTab.click()

  // Кадр — первый в навигаторе: маркеру всё равно, в каком кадре жить.
  const rows = page.locator('.ed-row')
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 })
  await rows.first().click()
  const frameTitle = await page.getByPlaceholder('Заголовок события').inputValue().catch(() => '')
  console.log(`кадр выбран: «${frameTitle}»`)
  await page.getByRole('button', { name: 'Открыть редактор Markdown' }).click()

  const textarea = page.getByLabel('Текст события в Markdown')
  await textarea.waitFor({ state: 'visible', timeout: 20_000 })
  const original = await textarea.inputValue()

  // 1. Панель «Разметка DOCX» вставляет маркеры в текст.
  await page.getByRole('button', { name: /Разметка DOCX/ }).click()
  await page.getByRole('button', { name: 'разрыв страницы' }).click()
  await page.getByRole('button', { name: 'оглавление' }).click()
  const withMarkers = await textarea.inputValue()
  for (const marker of ['<!-- sf:pagebreak -->', '<!-- sf:toc -->']) {
    if (!withMarkers.includes(marker)) problems.push(`панель не вставила ${marker}`)
  }
  const markerLines = withMarkers.split('\n').filter((line) => line.trim().startsWith('<!-- sf:'))
  if (markerLines.length !== 2) problems.push(`маркеров в тексте ${markerLines.length}, ожидалось 2`)
  for (const line of markerLines) {
    if (line.trim() !== line) problems.push(`маркер не отдельной строкой: ${JSON.stringify(line)}`)
  }
  // Снимок панели: маркеры в тексте видно глазами, а панель — нет ли переполнения.
  await page.screenshot({ path: '..\\_dev_shots\\docx-markers-panel.png' })
  const overflow = await page.evaluate(`(async () => {
    const body = document.querySelector('.md-editor__docx-body')
    if (!body) return 'нет панели'
    const box = body.getBoundingClientRect()
    return box.right > window.innerWidth + 1 ? 'панель за правым краем: ' + box.right : ''
  })()`)
  if (overflow) problems.push(String(overflow))

  // 2. Сохраняем — и ждём, пока маркер доедет до сервера (проекция CRDT отложенная).
  await page.getByRole('button', { name: 'Сохранить текст' }).click()
  if (await waitServer(true, 'сохранение')) {
    const result = await docx()
    await writeFile(OUT, result.bytes)
    console.log(`экспорт с маркерами: ${result.status}, ${result.bytes.length} байт → ${OUT}`)
    if (result.status !== 200) problems.push(`экспорт с маркерами: ${result.status}`)
  }

  // 3. Возвращаем исходный текст на место: стенд должен остаться прежним.
  await page.getByRole('button', { name: 'Открыть редактор Markdown' }).click()
  await textarea.waitFor({ state: 'visible', timeout: 20_000 })
  await textarea.fill(original)
  await page.getByRole('button', { name: 'Сохранить текст' }).click()
  await waitServer(false, 'восстановление')

  await browser.close()
  if (problems.length > 0) {
    console.log('проблемы:')
    for (const problem of problems) console.log(` - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`проблемы: нет; файл для проверки распаковкой: ${OUT}`)
}

await main()
