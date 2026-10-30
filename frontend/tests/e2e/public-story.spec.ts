import { test, expect, type Page } from '@playwright/test'
import { apiHeaders, signIn } from './support'

/**
 * Публичная история глазами читателя (0.136.0): ссылка на фразу.
 *
 * Ради чего сценарий. На публичной странице у читателя нет ни чата, ни редакторов, поэтому меню
 * выделения показывает ему одно действие — «ссылка на фразу». Дальше ссылка должна работать сама:
 * открыть ту же историю на том же кадре и подсветить фразу. Ни то, ни другое не видно в юнит-тестах:
 * там нет ни настоящей вёрстки стадии, ни `CSS.highlights`.
 *
 * Читатель — аноним (отдельный контекст без входа): страница обязана работать без авторизации.
 */
test.setTimeout(240_000)

const VIEWPORT = { width: 1280, height: 720 }

/** Проект с одной главой и фразой, которую будем выделять. */
async function publishedStory(page: Page): Promise<{ slug: string; projectId: string }> {
  const title = `История ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
  const projectId = page.url().split('/').pop() as string
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click({ timeout: 60_000 })

  // Текст кадра — через вкладку редакторов.
  await page.locator('[data-project-tab="editors"]').click({ timeout: 20_000 }).catch(() => undefined)
  await page.locator('.ed-row').first().click()
  const body = page.locator('.ed-form textarea').first()
  await expect(body).toBeVisible({ timeout: 30_000 })
  await body.fill('Аня вошла в дом и огляделась. За окном шёл снег.')

  // Публикация — через API: кнопка в настройках проверяется своими сценариями.
  const headers = await apiHeaders(page)
  const response = await page.request.post(`/api/projects/${projectId}/publication`, {
    headers,
    data: { is_public: true },
  })
  expect(response.status(), await response.text()).toBe(200)
  const project = (await response.json()) as { public_slug?: string | null }
  expect(project.public_slug, 'у опубликованного проекта должен быть slug').toBeTruthy()
  return { slug: project.public_slug as string, projectId }
}

const highlightSize = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights
    return registry?.get('sf-quote')?.size ?? 0
  })

test('читатель: выделил фразу → получил ссылку → по ссылке кадр с подсвеченной фразой', async ({
  page,
  browser,
}) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  const { slug } = await publishedStory(page)

  // Дальше — читатель без входа: свой контекст, чистые cookie и localStorage.
  const reader = await browser.newContext({ viewport: VIEWPORT })
  const readerPage = await reader.newPage()
  const errors: string[] = []
  readerPage.on('pageerror', (error) => errors.push(error.message))

  try {
    await readerPage.goto(`/s/${slug}`)
    const body = readerPage.locator('[data-frame-body]').first()
    await expect(body).toBeVisible({ timeout: 45_000 })
    await expect(body).toContainText('вошла в дом', { timeout: 30_000 })

    // Выделяем слово двойным щелчком по его координатам (как в project-сценарии).
    const point = await body.evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode() as Text | null
      while (text !== null) {
        const found = /\p{L}{5,}/u.exec(text.data)
        if (found) {
          const range = document.createRange()
          range.setStart(text, found.index + 1)
          range.setEnd(text, found.index + 2)
          const rect = range.getBoundingClientRect()
          if (rect.width > 0 && rect.top > 70 && rect.bottom < window.innerHeight - 20) {
            return { word: found[0], x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          }
        }
        text = walker.nextNode() as Text | null
      }
      return null
    })
    expect(point, 'в истории должно найтись слово от пяти букв').not.toBeNull()
    await readerPage.mouse.dblclick(point!.x, point!.y)

    // Читателю — одно действие, членских кнопок нет.
    const menu = readerPage.locator('[data-selection-menu]')
    await expect(menu).toBeVisible({ timeout: 15_000 })
    await expect(menu).toHaveAttribute('data-selection-audience', 'readers')
    await expect(readerPage.locator('[data-selection-link]')).toBeVisible()
    await expect(readerPage.locator('[data-selection-chat]')).toHaveCount(0)
    await expect(readerPage.locator('[data-selection-edit]')).toHaveCount(0)

    await readerPage.locator('[data-selection-link]').click()
    const dialog = readerPage.locator('[data-quote-link]')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    const url = await readerPage.locator('[data-quote-link-field]').inputValue()
    expect(url).toContain(`/s/${slug}?`)
    const params = new URL(url).searchParams
    expect(params.get('frame')).toBeTruthy()
    expect(params.get('q')).toBeTruthy()

    // Открываем ссылку как обычный адрес — она обязана привести к той же строке.
    await dialog.locator('[data-quote-link-close]').click()
    await readerPage.goto(url)
    await expect(readerPage.locator('[data-frame-body]').first()).toContainText(params.get('q')!, {
      timeout: 45_000,
    })
    await expect
      .poll(() => highlightSize(readerPage), { timeout: 30_000, message: 'фраза должна быть подсвечена' })
      .toBeGreaterThan(0)

    // И подсветка в пределах экрана: лист подкручен к фразе.
    const rect = await readerPage.evaluate(() => {
      const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
      const highlighted = registry?.get('sf-quote')
      const first = highlighted ? Array.from(highlighted)[0] : undefined
      if (!first) return null
      const box = first.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom }
    })
    expect(rect).not.toBeNull()
    expect(rect!.top).toBeGreaterThanOrEqual(0)
    expect(rect!.top).toBeLessThanOrEqual(VIEWPORT.height - 24)

    expect(errors, `ошибки страницы: ${errors.join(' | ')}`).toEqual([])
  } finally {
    await reader.close()
  }
})
