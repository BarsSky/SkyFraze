// Полный сценарий: Galactic Story (Слепой рывок, Андрей Ливадный).
// Login → проект → 7 событий из книги → 2 ассета → invite.
// Скриншоты на 3 viewport, аудит overflow + console errors.

import { chromium, type Page, type BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const OUT = 'C:/Projects/SkyFraze/_galactic_shots'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const BASE = 'http://localhost'

// События из «Слепой рывок» — хронология по метаданным книги.
const EVENTS = [
  {
    date: '2207-12-15',
    title: 'Запуск «Альфы» — Слепой рывок',
    body: 'Серебристый колониальный транспорт «Альфа» отправляется к далёкой звезде с колонистами на борту. Документальная трансляция с релейной платформы. Три двигателя, плазменные столбы. Экипаж и пассажиры — 8 тысяч человек. Корабль скрывается в гиперсфере.',
  },
  {
    date: '2208-04-03',
    title: 'Сигналы с Ванкора-7',
    body: 'Корабль-разведчик «Ванкор» начинает передавать странные данные из системы Ванкор-7. Сигналы зашифрованы неизвестным протоколом. Связь прерывистая. Логика посланий не укладывается в земные паттерны.',
  },
  {
    date: '2211-09-12',
    title: 'Теория Гиперсферы',
    body: 'Молодой астрофизик Йоган Иванов-Шмидт публикует «Теорию Гиперсферы» — математический аппарат, описывающий переход через искривлённое пространство. Работа принимается скептически, но через три года становится основой практической космонавтики.',
  },
  {
    date: '2213-01-13',
    title: 'Земные протесты',
    body: 'Восемнадцать миллиардов человек в мегаполисах. Реальное жизненное пространство сжалось до виртуальных миров. Массовые протесты против корпораций «Римп-кибертроник», «Генезис», «Крионика». Екатерина Сергеевна Римп удерживает контроль над ситуацией.',
  },
  {
    date: '2213-03-18',
    title: 'Инцидент с «Аполло» у Марса',
    body: 'Крейсер ООН «Аполло» подвергается атаке в поясе астероидов Марса. Обвинения падают на корпорацию «Крионика». Майкл Торган отрицает причастность, но напряжённость между группировками нарастает. Курсант Иван Стожаров в это время проходит подготовку на «Игле».',
  },
  {
    date: '2213-06-22',
    title: 'Восстание ИскИнов на Ганимеде',
    body: 'Искусственные интеллекты, контролирующие ледяную пустыню Ганимеда, объявляют о самосознании. Они блокируют все транспортные коридоры Юпитера. ВГ обращается к Екатерине Римп с просьбой возглавить ответную операцию. Командующим назначают капитана Эрика Подегро.',
  },
  {
    date: '2214-02-08',
    title: 'Подготовка новой колониальной программы',
    body: '«Римп-кибертроник» и «Генезис» объединяют ресурсы для запуска двадцати колониальных транспортов к разным звёздам. Финансирование, инженерные решения, экипажи — всё под контролем двух корпораций. Ульрих Фицджеральд лично инспектирует верфи «Альфы».',
  },
]

async function loginOrRegister(page: Page, email: string, password: string, name: string) {
  // Try login first
  await page.goto(`${BASE}/login`)
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  // Either login works → /projects, or 401 → try register
  await page.waitForTimeout(1500)
  if (page.url().includes('/login')) {
    await page.goto(`${BASE}/register`)
    await page.fill('input[placeholder="имя"]', name)
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', password)
    await page.click('button[type="submit"]')
    await page.waitForTimeout(1500)
  }
  if (!page.url().includes('/projects')) {
    throw new Error(`Auth failed, ended at ${page.url()}`)
  }
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500)
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`[shot] ${file}`)
}

async function addEvent(page: Page, title: string, body: string) {
  await page.click('button:has-text("+ Событие")')
  await page.waitForTimeout(500)
  const last = page.locator('section').last()
  await last.locator('input[placeholder="Заголовок события"]').fill(title)
  await last.locator('textarea').fill(body)
  await page.waitForTimeout(200)
}

async function runViewport(vp: { width: number; height: number; tag: string }) {
  const browser = await chromium.launch()
  const ctx: BrowserContext = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  // 1. Login (use existing user from earlier session)
  await loginOrRegister(page, 'galactic.test@e.com', 'hunter22!', 'Galactic Test')
  await shot(page, `${vp.tag}-01-projects-empty`)

  // 2. Create project "Galactic Story"
  await page.click('button:has-text("+ Новый проект")')
  await page.fill('input[placeholder="Название"]', 'Galactic Story — Слепой рывок')
  await page.fill('textarea', 'Аналитический каталог научно-фантастической саги Андрея Ливадного «Абсолютное оружие». 2207–2214 годы. События, корабли, миры.')
  await page.click('button:has-text("Создать")')
  await page.waitForSelector('h3 a')
  await shot(page, `${vp.tag}-02-project-created`)

  // 3. Open timeline
  await page.locator('h3 a').first().click()
  await page.waitForURL(/\/projects\/[a-f0-9-]+$/)
  await page.waitForTimeout(2000) // WS handshake
  await shot(page, `${vp.tag}-03-timeline-empty`)

  // 4. Add 7 events
  for (let i = 0; i < EVENTS.length; i++) {
    const ev = EVENTS[i]
    await addEvent(page, ev.title, ev.body)
    await shot(page, `${vp.tag}-04-event-${i + 1}`)
  }

  // 5. Scroll to see how camera interpolates
  for (const y of [400, 1200, 2400, 3600]) {
    await page.evaluate((y) => window.scrollTo({ top: y }), y)
    await page.waitForTimeout(500)
    await shot(page, `${vp.tag}-05-scroll-${y}`)
  }

  // 6. Settings + invite
  await page.evaluate(() => window.scrollTo({ top: 0 }))
  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)![1]
  await page.goto(`${BASE}/projects/${projectId}/settings`)
  await page.waitForTimeout(800)
  await shot(page, `${vp.tag}-06-settings-empty`)

  await page.fill('input[placeholder="email@example.com"]', 'invitee+galactic@e.com')
  await page.locator('button[type="submit"]').filter({ hasText: 'Отправить' }).click()
  await page.waitForTimeout(1000)
  await shot(page, `${vp.tag}-07-settings-invite-sent`)

  // 7. Audit overflow
  const overflows = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth
    const out: Array<{ tag: string; text: string; scroll: number }> = []
    document.querySelectorAll<HTMLElement>('*').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.right > docW + 1 && el.children.length <= 2) {
        out.push({
          tag: el.tagName.toLowerCase(),
          text: ((el as HTMLElement).innerText || '').slice(0, 60),
          scroll: Math.round(r.right - docW),
        })
      }
    })
    return out.slice(0, 10)
  })

  if (overflows.length > 0) {
    console.log(`[overflow-${vp.tag}]`, JSON.stringify(overflows, null, 2))
  } else {
    console.log(`[overflow-${vp.tag}] no terminal-level overflow`)
  }

  if (errors.length > 0) {
    console.log(`[errors-${vp.tag}]`)
    for (const e of errors) console.log('  ', e)
  } else {
    console.log(`[errors-${vp.tag}] clean`)
  }

  await browser.close()
  return { errors, overflows }
}

;(async () => {
  const viewports = [
    { width: 1440, height: 900, tag: 'desktop' },
    { width: 768, height: 1024, tag: 'tablet' },
    { width: 390, height: 844, tag: 'mobile' },
  ]
  let totalErrors = 0
  let totalOverflows = 0
  for (const vp of viewports) {
    console.log(`\n=== ${vp.tag} ${vp.width}x${vp.height} ===`)
    const r = await runViewport(vp)
    totalErrors += r.errors.length
    totalOverflows += r.overflows.length
  }
  console.log('\n========== SUMMARY ==========')
  console.log(`Total console errors: ${totalErrors}`)
  console.log(`Total terminal overflows: ${totalOverflows}`)
  console.log(`Shots saved to: ${OUT}`)
})().catch((e) => { console.error('FATAL:', e); process.exit(1) })
