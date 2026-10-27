import { test, expect, type Page } from '@playwright/test'
import { signIn } from './support'

/**
 * Прокрутка проекта и режимы работы: шапка на месте, внизу не пусто, вкладки переключают
 * содержимое, а не прокручивают страницу.
 *
 * Что здесь закрепляется.
 *
 * 1. Прокрутка проекта живёт в `main` (`.layout main { overflow:auto }`), но когда он доходил
 *    до конца, жест уходил дальше — в сам документ (scroll chaining). Снаружи это выглядело так:
 *    шапка с меню уезжала за экран, контент визуально оказывался ниже своего конца.
 * 2. С 0.83.0 у владельца и соавторов появились ВКЛАДКИ: «Проект / Редакторы / Связи / Версии».
 *    До этого кнопки прокручивали страницу к разделам, лежащим друг под другом, и «Связи»
 *    наезжали на показ проекта. Проверяем обратное: в каждой вкладке видно только её содержимое,
 *    стадия живёт только в «Проекте», и внизу страницы нет пустоты.
 *
 * Проверяем настоящим колесом мыши, а не программной прокруткой.
 */
async function openProjectWithEditors(page: Page): Promise<void> {
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  const title = `Прокрутка ${Date.now()}`
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  // Пустой проект: первый кадр создаётся кнопкой пустого состояния, после него появляются
  // вкладки режимов.
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  await page.locator('[data-project-tabs]').waitFor()
  await page.locator('.sf-track').waitFor()
}

test('прокрутка проекта не уводит шапку и не оставляет пустоту', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await openProjectWithEditors(page)

  // Крутим вниз колесом до упора: так это делает человек. Вкладка «Проект» остаётся
  // единственным содержимым страницы — значит, внизу не может быть пустоты.
  await page.mouse.move(640, 360)
  for (let i = 0; i < 80; i += 1) await page.mouse.wheel(0, 700)
  await page.waitForTimeout(600)

  const bottom = await page.evaluate(() => {
    const main = document.querySelector('.layout main') as HTMLElement
    const header = document.querySelector('.layout header') as HTMLElement
    const stage = document.querySelector('.sf-stage') as HTMLElement
    const track = document.querySelector('.sf-track') as HTMLElement
    return {
      windowScrollY: Math.round(window.scrollY),
      mainAtEnd: Math.abs(main.scrollHeight - main.clientHeight - main.scrollTop) < 2,
      headerTop: Math.round(header.getBoundingClientRect().top),
      editorsMounted: document.querySelector('[data-editor-panel]') !== null,
      stageVisibility: getComputedStyle(stage).visibility,
      trackInView: Math.round(track.getBoundingClientRect().bottom) > 0,
    }
  })

  // Документ не прокручивается: иначе шапка уезжает и контент «уходит ниже себя».
  expect(bottom.windowScrollY).toBe(0)
  expect(bottom.mainAtEnd).toBe(true)
  expect(bottom.headerTop).toBe(0)
  // Вкладка «Проект»: панели редакторов здесь нет, а сцена и трек — есть.
  expect(bottom.editorsMounted).toBe(false)
  expect(bottom.trackInView).toBe(true)
  expect(bottom.stageVisibility).toBe('visible')
})

test('вкладки переключают содержимое: стадия только в «Проекте»', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await openProjectWithEditors(page)

  // «Редакторы»: панель есть, сцены нет.
  await page.locator('[data-project-tab="editors"]').click()
  await expect(page.locator('[data-editor-panel]')).toBeVisible()
  expect(await page.locator('.sf-root').count()).toBe(0)

  // «Связи»: карточки и граф есть, панели редакторов нет.
  await page.locator('[data-project-tab="relations"]').click()
  await expect(page.locator('[data-relations]')).toBeVisible()
  expect(await page.locator('[data-editor-panel]').count()).toBe(0)

  // «Версии»: история версий как раздел, а не окно поверх проекта.
  await page.locator('[data-project-tab="versions"]').click()
  await expect(page.locator('[data-versions-embedded]')).toBeVisible()
  expect(await page.locator('[data-editor-panel]').count()).toBe(0)

  // Назад в «Проект»: сцена вернулась, панелей нет.
  await page.locator('[data-project-tab="project"]').click()
  await expect(page.locator('.sf-root')).toBeVisible()
  expect(await page.locator('[data-editor-panel]').count()).toBe(0)
  expect(await page.locator('[data-versions-embedded]').count()).toBe(0)

  // Помощник доступен в любом режиме: это плавающая кнопка, а не вкладка.
  await expect(page.locator('[data-assistant-fab]')).toBeVisible()
})
