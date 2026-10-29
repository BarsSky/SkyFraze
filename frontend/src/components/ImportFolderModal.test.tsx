import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { MarkdownImportPreview } from '../api/storyFiles'
import { ImportFolderModal } from './ImportFolderModal'
import { setLang } from '../store/lang'

/**
 * Окно импорта папки: выбор папки, предпросмотр и запрет «Создать» на пустом
 * дереве.
 *
 * Сеть подменена: проверяем поведение окна, а не разбор ответа (он в
 * `storyFiles.test.ts`). Отдельно закреплено, что у поля выбора папки есть
 * `webkitdirectory`: без этого атрибута браузер отдаёт файлы без относительных
 * путей, и дерево у сервера не собирается.
 */
const mocks = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn(), errorText: vi.fn() }))

// Сеть подменяем целиком: настоящий модуль тянет HTTP-клиент, а окну от него
// нужны только эти три вызова.
vi.mock('../api/storyFiles', () => ({
  previewMarkdownImport: mocks.preview,
  importMarkdownFolder: mocks.create,
  readImportErrorMessage: mocks.errorText,
}))

const preview: MarkdownImportPreview = {
  projectTitle: 'Планета',
  events: [
    { number: '01', depth: 0, title: 'Пролог', path: '01-Пролог.md', chars: 1200, warnings: [] },
    {
      number: '01.1',
      depth: 1,
      title: 'Первая встреча',
      path: '01.1-Первая встреча.md',
      chars: 0,
      warnings: ['пустой файл'],
    },
  ],
  warnings: ['в проект не попали файлов: 2 — на них нет ссылок в текстах событий'],
  stats: {
    files: 2,
    events: 2,
    chars: 1200,
    imageLinks: 2,
    attachments: 1,
    missingFiles: 1,
    unusedFiles: 2,
    attachmentBytes: 2 * 1024 * 1024,
  },
  quotaBytes: 10 * 1024 * 1024,
}

/** Портал рендерит окно в body — оборачиваем в роутер: внутри бывает баннер ошибки. */
function show() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ImportFolderModal onClose={() => {}} onCreated={() => {}} />
    </MemoryRouter>,
  )
}

function inputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('.sf-import input[type="file"]'))
}

describe('ImportFolderModal', () => {
  beforeEach(() => {
    setLang('ru')
    mocks.preview.mockReset()
    mocks.create.mockReset()
    mocks.errorText.mockReset()
    mocks.errorText.mockResolvedValue(null)
  })

  it('поле выбора папки помечено webkitdirectory, а второе принимает zip', () => {
    show()
    const [folder, archive] = inputs()

    expect(folder.hasAttribute('webkitdirectory')).toBe(true)
    expect(folder.multiple).toBe(true)
    expect(archive.getAttribute('accept')).toBe('.zip,application/zip')
  })

  it('пустой выбор папки не идёт в сеть', () => {
    show()
    fireEvent.change(inputs()[0], { target: { files: undefined } })
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it('после выбора zip показывает дерево, знаки и предупреждения', async () => {
    mocks.preview.mockResolvedValue(preview)
    show()

    const zip = new File(['PK'], 'story.zip', { type: 'application/zip' })
    fireEvent.change(inputs()[1], { target: { files: [zip] } })

    expect(await screen.findByText('Пролог')).toBeInTheDocument()
    expect(screen.getByText('01.1')).toBeInTheDocument()
    expect(screen.getByText(/1200 зн\./)).toBeInTheDocument()
    expect(screen.getByText(/не попали файлов/)).toBeInTheDocument()
    // Вложения показаны отдельным счётчиком: человек видит, что картинки поехали.
    // Проверяем по тексту блока статистики: число и слово лежат в разных узлах.
    expect(document.querySelector('[data-import-stats]')?.textContent ?? '').toContain('1 вложение')
    expect(screen.getByText(/пустой файл/)).toBeInTheDocument()
    // Заголовок проекта подставлен из ответа сервера, а не выдуман окном.
    expect(screen.getByLabelText('Название проекта')).toHaveValue('Планета')
    expect(mocks.preview).toHaveBeenCalledTimes(1)
  })

  it('на пустом дереве создавать нечего', async () => {
    mocks.preview.mockResolvedValue({
      ...preview,
      events: [],
      stats: {
        files: 1,
        events: 0,
        chars: 0,
        imageLinks: 0,
        attachments: 0,
        missingFiles: 0,
        unusedFiles: 0,
        attachmentBytes: 0,
      },
    })
    show()

    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'empty.zip')] } })

    await waitFor(() => expect(screen.getByText(/создавать нечего/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Создать проект' })).toBeDisabled()
  })

  it('показывает вес вложений и предупреждает, если набор не влезет в предел', async () => {
    // Набор на 24 МБ при пределе 10 МБ: раньше человек узнавал об этом из отказа
    // уже после импорта.
    mocks.preview.mockResolvedValue({
      ...preview,
      quotaBytes: 10 * 1024 * 1024,
      stats: { ...preview.stats, attachments: 40, attachmentBytes: 24 * 1024 * 1024 },
    })
    show()

    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'big.zip')] } })

    expect(await screen.findByText(/вложения: 40 · 24\.0 МБ/)).toBeInTheDocument()
    const quota = await screen.findByRole('status')
    expect(quota.textContent).toContain('не поместится')
    expect(quota.textContent).toContain('10.0 МБ')
  })

  it('набор, который помещается, веса не скрывает и не пугает', async () => {
    mocks.preview.mockResolvedValue(preview)
    show()

    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'story.zip')] } })

    expect(await screen.findByText(/вложения: 1 · 2\.0 МБ/)).toBeInTheDocument()
    expect(document.querySelector('[data-import-quota]')).toBeNull()
  })

  it('ошибку сервера показывает текстом сервера и проект не создаёт', async () => {
    mocks.preview.mockRejectedValue(new Error('сеть недоступна'))
    mocks.errorText.mockResolvedValue('слишком много файлов: больше 2000')
    show()

    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'big.zip')] } })

    expect(await screen.findByText('слишком много файлов: больше 2000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Создать проект' })).toBeDisabled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  /**
   * 0.124.0: подписи окна — из словаря, включая склонения («1 вложение» → «1 attachment») и
   * «1200 зн.». Что прислал сервер — названия событий, предупреждения — остаётся как есть.
   */
  it('на английском подписи окна и счётчики переведены', async () => {
    setLang('en')
    mocks.preview.mockResolvedValue(preview)
    show()

    expect(screen.getByText('Folder import')).toBeInTheDocument()
    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'story.zip')] } })

    expect(await screen.findByText('Event tree')).toBeInTheDocument()
    expect(screen.getByLabelText('Project name')).toHaveValue('Планета')
    const stats = document.querySelector('[data-import-stats]')?.textContent ?? ''
    expect(stats).toContain('2 files')
    expect(stats).toContain('2 events')
    // Число в формате локали (1,200) и слово в форме языка.
    expect(stats).toContain('1,200 chars')
    expect(stats).toContain('2 image links')
    expect(stats).toContain('1 attachment')
    expect(stats).toContain('attachments: 1 · 2.0 MB')
    expect(screen.getByRole('button', { name: 'Create the project' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    // Данные сервера не переводим.
    expect(screen.getByText('Пролог')).toBeInTheDocument()
  })
})
