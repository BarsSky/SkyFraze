import { test, expect, devices, type Page } from '@playwright/test'
import { openProjectTab, signIn } from './support'

/**
 * Проект на телефоне (0.135.0) — дым по рабочей части, а не по одному выделению.
 *
 * Появился после отчёта «на 6 дюймах выделение не открывает меню, остаётся только фон»: поломка
 * была не в выделении как таковом, а в вёрстке стадии на узком экране, и на телефоне её тогда
 * проверял только сценарий про выделение. Здесь — то, что человек на телефоне делает постоянно:
 * вкладки, чипы, лист кадра, кнопки «назад/дальше», плавающая кнопка помощника. Плюс общие
 * стражи: нет горизонтального переполнения и нет ошибок страницы (крах React виден именно так).
 */
test.setTimeout(180_000)

const log = (page: Page, ...args: unknown[]) => console.log('[mobile]', ...args)

test('телефон: проект открывается, кнопки на месте и нажимаются, страница не падает', async ({
  browser,
}) => {
  const context = await browser.newContext({ ...devices['Pixel 5'] })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const signedIn = await signIn(page)
  if (!signedIn) {
    await context.close()
    test.skip(true, 'учётной записи e2e нет и регистрация закрыта')
  }

  try {
    await page.setViewportSize({ width: 390, height: 844 })

    // Проект и первая глава — через интерфейс: подписи на телефоне те же, вкладки появляются
    // только когда есть содержимое.
    const title = `Телефон ${Date.now()}`
    await page.getByRole('button', { name: '+ Новый проект' }).click()
    await page.getByPlaceholder('Название').fill(title)
    await page.getByRole('button', { name: 'Создать' }).click()
    await page.getByRole('link', { name: title }).click()
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/)
    await page.getByRole('button', { name: '+ Добавить первую главу' }).click({ timeout: 60_000 })

    // Пустая глава — это пустой кадр: текста в нём нет, и выделять нечего. Пишем пару строк в
    // редакторах (на телефоне это отдельная вкладка) и возвращаемся в показ.
    await openProjectTab(page, 'editors')
    await page.locator('.ed-row').first().click()
    const editor = page.locator('.ed-form textarea').first()
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.fill('Начало истории.\n\nТак начинается рассказ.')
    await openProjectTab(page, 'project')

    // Вкладки режимов: видны, внутри экрана, нажимаются и не перекрыты.
    const tabs = page.getByRole('tablist', { name: 'Режим проекта' })
    await expect(tabs).toBeVisible({ timeout: 30_000 })
    for (const name of ['Проект', 'Редакторы', 'Связи', 'Версии', 'Настройки']) {
      const tab = tabs.getByRole('tab', { name })
      await expect(tab).toBeVisible()
      const box = await tab.boundingBox()
      expect(box, `вкладка ${name}`).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(390)
      expect(box!.height, `высота вкладки ${name}`).toBeGreaterThanOrEqual(28)
    }

    // Лист кадра и текст: на телефоне он занимает экран, а не прячется.
    const body = page.locator('[data-frame-body]').first()
    await expect(body).toBeVisible({ timeout: 45_000 })
    expect((await body.innerText()).trim().length).toBeGreaterThan(10)

    // Чипы глав и кнопки «назад/дальше» — цель нажатия пальцем.
    const nav = page.locator('.sf-copy__nav').first()
    await expect(nav).toBeVisible()
    const navBox = await nav.boundingBox()
    expect(navBox).not.toBeNull()
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(844)

    // Плавающая кнопка помощника: касание открывает окно, Esc закрывает.
    const fab = page.locator('[data-assistant-fab]')
    await expect(fab).toBeVisible()
    const fabBox = (await fab.boundingBox())!
    expect(fabBox.width).toBeGreaterThanOrEqual(40)
    expect(fabBox.height).toBeGreaterThanOrEqual(40)
    await page.touchscreen.tap(fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2)
    const panel = page.locator('[data-assistant-panel]')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden({ timeout: 10_000 })

    // Горизонтального переполнения на телефоне быть не должно.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    log(page, 'переполнение по горизонтали, px:', overflow)
    expect(overflow).toBeLessThanOrEqual(0)

    expect(pageErrors, `ошибки страницы: ${pageErrors.join(' | ')}`).toEqual([])
  } finally {
    await context.close().catch(() => undefined)
  }
})
