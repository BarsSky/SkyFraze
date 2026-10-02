import { test, expect, type Page } from '@playwright/test'
import { signIn } from './support'

/**
 * Прокрутка страницы проекта: одна прокрутка, шапка на месте, без пустоты внизу.
 *
 * Что здесь закрепляется. Прокрутка проекта живёт в `main` (`.layout main { overflow:auto }`),
 * но когда он доходил до конца, жест уходил дальше — в сам документ (scroll chaining).
 * Снаружи это выглядело так: шапка с меню уезжала за экран, контент визуально оказывался
 * ниже своего конца (внизу открывалась пустая область), а возвращаясь назад, человек видел,
 * что пустота «накрывает» редактор. Вторая половина беды — стадия: её fixed-слой оставался
 * живым, пока трек занимал больше половины экрана, и перекрывал панель редакторов.
 *
 * Проверяем ровно эти три вещи настоящим колесом мыши, а не программной прокруткой:
 * документ не двигается, шапка видна, стадия гаснет, как только редактор показался.
 */
async function openProjectWithEditors(page: Page): Promise<void> {
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  const title = `Прокрутка ${Date.now()}`
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  // Пустой проект: первый кадр создаётся кнопкой пустого состояния, затем появляется
  // панель редакторов и трек таймлайна.
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  await page.locator('[data-editor-panel]').waitFor()
  await page.locator('.sf-track').waitFor()
}

test('прокрутка проекта не уводит шапку и не оставляет пустоту', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')
  await openProjectWithEditors(page)

  // Крутим вниз колесом до упора: так это делает человек.
  await page.mouse.move(640, 360)
  for (let i = 0; i < 80; i += 1) await page.mouse.wheel(0, 700)
  await page.waitForTimeout(600)

  const bottom = await page.evaluate(() => {
    const main = document.querySelector('.layout main') as HTMLElement
    const header = document.querySelector('.layout header') as HTMLElement
    const editors = document.querySelector('[data-editor-panel]') as HTMLElement
    const stage = document.querySelector('.sf-stage') as HTMLElement
    return {
      windowScrollY: Math.round(window.scrollY),
      mainAtEnd: Math.abs(main.scrollHeight - main.clientHeight - main.scrollTop) < 2,
      headerTop: Math.round(header.getBoundingClientRect().top),
      editorsBottom: Math.round(editors.getBoundingClientRect().bottom),
      stageAttr: document.querySelector('.sf-root')?.getAttribute('data-stage'),
      stageVisibility: getComputedStyle(stage).visibility,
    }
  })

  // Документ не прокручивается: иначе шапка уезжает и контент «уходит ниже себя».
  expect(bottom.windowScrollY).toBe(0)
  expect(bottom.mainAtEnd).toBe(true)
  expect(bottom.headerTop).toBe(0)
  // Внизу не пусто: низ панели редакторов виден в пределах экрана, а не выше него.
  expect(bottom.editorsBottom).toBeGreaterThan(0)
  // Стадия погашена: её fixed-слой не перекрывает редактор.
  expect(bottom.stageAttr).toBe('idle')
  expect(bottom.stageVisibility).toBe('hidden')

  // Один экран вверх: редактор виден, стадия по-прежнему погашена (раньше она здесь
  // оживала, потому что хвост трека занимал половину экрана).
  await page.mouse.wheel(0, -700)
  await page.waitForTimeout(500)
  const up = await page.evaluate(() => {
    const editors = document.querySelector('[data-editor-panel]') as HTMLElement
    const stage = document.querySelector('.sf-stage') as HTMLElement
    return {
      windowScrollY: Math.round(window.scrollY),
      editorsVisible: editors.getBoundingClientRect().top < window.innerHeight,
      stageAttr: document.querySelector('.sf-root')?.getAttribute('data-stage'),
      stageVisibility: getComputedStyle(stage).visibility,
    }
  })
  expect(up.windowScrollY).toBe(0)
  expect(up.editorsVisible).toBe(true)
  expect(up.stageAttr).toBe('idle')
  expect(up.stageVisibility).toBe('hidden')
})
