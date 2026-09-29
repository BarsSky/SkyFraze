import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { MarkdownImportPreview } from '../api/storyFiles'
import { ImportFolderModal } from './ImportFolderModal'

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
  warnings: ['картинки не переносятся: 2 ссылки'],
  stats: { files: 2, events: 2, chars: 1200, imageLinks: 2 },
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
    expect(screen.getByText(/картинки не переносятся/)).toBeInTheDocument()
    expect(screen.getByText(/пустой файл/)).toBeInTheDocument()
    // Заголовок проекта подставлен из ответа сервера, а не выдуман окном.
    expect(screen.getByLabelText('Название проекта')).toHaveValue('Планета')
    expect(mocks.preview).toHaveBeenCalledTimes(1)
  })

  it('на пустом дереве создавать нечего', async () => {
    mocks.preview.mockResolvedValue({ ...preview, events: [], stats: { files: 1, events: 0, chars: 0, imageLinks: 0 } })
    show()

    fireEvent.change(inputs()[1], { target: { files: [new File(['PK'], 'empty.zip')] } })

    await waitFor(() => expect(screen.getByText(/создавать нечего/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Создать проект' })).toBeDisabled()
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
})
