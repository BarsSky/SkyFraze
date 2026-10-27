import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
const problems: string[] = []
p.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
p.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
await p.goto(`${BASE}/login`)
await p.getByPlaceholder('email').fill('dev.check@example.com')
await p.getByPlaceholder('пароль').fill('hunter22!')
await p.getByRole('button', { name: /Войти/ }).click()
await p.waitForURL(/\/projects$/)
await p.goto(`${BASE}/projects/167edf2e-876a-4ef2-bd04-155efb648343`)
await p.locator('[data-project-tabs]').waitFor({ state: 'visible', timeout: 45000 })
await p.waitForTimeout(1500)
for (const tab of ['project', 'editors', 'relations', 'versions']) {
  await p.click(`[data-project-tab="${tab}"]`)
  await p.waitForTimeout(900)
  const info = await p.evaluate(`(async () => {
    var tabs = Array.from(document.querySelectorAll('[data-project-tab]')).map(function (b) { return b.textContent + (b.getAttribute('aria-selected') === 'true' ? '*' : '') })
    return {
      tabs: tabs,
      editor: !!document.querySelector('[data-editor-panel]'),
      relations: !!document.querySelector('[data-relations]'),
      versions: !!document.querySelector('[data-versions-embedded]'),
      stage: !!document.querySelector('.sf-root'),
      assistant: !!document.querySelector('[data-assistant-fab]'),
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })()`)
  console.log(tab, JSON.stringify(info))
  await p.screenshot({ path: `..\\_dev_shots\\tab-${tab}.png` })
}
console.log('проблемы:', problems.length === 0 ? 'нет' : problems)
await b.close()
