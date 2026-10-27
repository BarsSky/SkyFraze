import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { signIn, openEditorsTab } from './support'

/**
 * Книга файлом через браузер: меню «Книга» → скачивание → файл действительно архив нужного
 * вида.
 *
 * Почему проверяем байты, а не «скачивание началось». `Content-Type` и заголовок файла
 * проверяются в Go-тестах; здесь важно, что нажатие в интерфейсе приводит к скачиванию
 * настоящего файла: ZIP начинается с «PK», а внутри лежат `mimetype` с типом EPUB (для
 * EPUB) или `word/document.xml` (для DOCX). Сценарий, который проверяет только имя файла,
 * пропустил бы пустой или битый архив.
 */
test.setTimeout(120_000)

test('книга скачивается как EPUB и DOCX', async ({ page }) => {
  test.skip(!(await signIn(page)), 'учётной записи e2e нет и регистрация закрыта')

  // Проект с одним кадром: книга без содержимого проверяла бы только упаковку.
  const title = `Книга ${Date.now()}`
  await page.getByRole('button', { name: '+ Новый проект' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('link', { name: title }).click()
  await page.getByRole('button', { name: '+ Добавить первую главу' }).click()
  await openEditorsTab(page)
  await expect(page.locator('.ed-row--chapter', { hasText: 'Новая глава' }).first()).toBeVisible({
    timeout: 30_000,
  })

  // Возвращаемся к списку проектов: меню скачивания живёт в карточке проекта.
  await page.getByRole('link', { name: 'Мои проекты' }).first().click()
  await expect(page).toHaveURL(/\/projects$/)
  const card = page.locator('.card', { hasText: title }).first()
  await expect(card).toBeVisible()

  /** Открывает меню «Книга» в карточке и скачивает нужный формат. */
  async function download(button: string, extension: string) {
    const menu = card.locator('.dl-menu', { hasText: 'Книга' })
    await menu.locator('summary').click()
    const [file] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      menu.getByRole('button', { name: button }).click(),
    ])
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`))
    const path = await file.path()
    return fs.readFile(path)
  }

  const epub = await download('Скачать .epub', 'epub')
  // ZIP: «PK\x03\x04». EPUB: `mimetype` хранится без сжатия, поэтому строка видна в байтах.
  expect(epub.subarray(0, 2).toString('latin1')).toBe('PK')
  const epubText = epub.toString('latin1')
  expect(epubText).toContain('mimetype')
  expect(epubText).toContain('application/epub+zip')
  expect(epubText).toContain('OEBPS/content.opf')
  expect(epubText).toContain('nav.xhtml')

  const docx = await download('Скачать .docx', 'docx')
  expect(docx.subarray(0, 2).toString('latin1')).toBe('PK')
  const docxText = docx.toString('latin1')
  expect(docxText).toContain('[Content_Types].xml')
  expect(docxText).toContain('word/document.xml')
})
