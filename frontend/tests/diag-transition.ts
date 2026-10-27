import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
await p.goto(`${BASE}/login`)
await p.getByPlaceholder('email').fill('dev.check@example.com')
await p.getByPlaceholder('пароль').fill('hunter22!')
await p.getByRole('button', { name: /Войти/ }).click()
await p.waitForURL(/\/projects$/)
await p.goto(`${BASE}/projects/167edf2e-876a-4ef2-bd04-155efb648343`)
await p.locator('[data-relations]').waitFor({ state: 'visible', timeout: 45000 })
await p.waitForTimeout(1500)
const shots = []
for (const relTopTarget of [700, 400, 120, 0]) {
  const info = await p.evaluate(`(async (target) => {
    var main = document.querySelector('main')
    var rel = document.querySelector('[data-relations]')
    // подбираем scrollTop, при котором верх раздела окажется на target
    var guard = 0
    while (guard < 4000) {
      var top = Math.round(rel.getBoundingClientRect().top)
      if (Math.abs(top - target) <= 8) break
      main.scrollTop += (top - target)
      await new Promise(function (r) { setTimeout(r, 30) })
      guard += 30
    }
    var root = document.querySelector('.sf-root')
    var stage = document.querySelector('.sf-stage')
    return {
      target: target,
      scroll: Math.round(main.scrollTop),
      relTop: Math.round(rel.getBoundingClientRect().top),
      stageState: root ? root.getAttribute('data-stage') : null,
      stageHidden: stage ? getComputedStyle(stage).visibility === 'hidden' : null,
    }
  })(${JSON.stringify(relTopTarget)})`)
  await p.waitForTimeout(250)
  const file = `..\\_dev_shots\\transition-${relTopTarget}.png`
  await p.screenshot({ path: file })
  shots.push({ info, file })
}
console.log(JSON.stringify(shots, null, 2))
await b.close()
