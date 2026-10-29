import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MentionImage } from './MentionImage'
import { setLang } from '../../store/lang'

/**
 * Картинка у упоминания (0.93.0).
 *
 * Проверяем то, что видит человек: без картинки есть приглашение привязать, с картинкой —
 * превью и «отвязать», выбор берётся из КАРТИНОК проекта (pdf в списке «как это выглядит» —
 * ошибка выбора), а читателю кнопок нет вовсе.
 */

vi.mock('../../api/assets', () => ({
  listAssets: vi.fn(async () => [
    { id: 'a1', filename: 'портрет.png', mime: 'image/png' },
    { id: 'a2', filename: 'письмо.pdf', mime: 'application/pdf' },
    { id: 'a3', filename: 'вид.png', mime: 'image/webp' },
  ]),
}))

vi.mock('../../api/assetObject', () => ({
  useAssetObjectUrl: (id?: string | null) => (id ? `blob:${id}` : null),
}))

beforeEach(() => {
  setLang('ru')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const base = {
  projectId: 'p1',
  entityId: 'e1',
  entityName: 'Анна',
  eventId: 'f1',
  eventTitle: 'Пролог',
  canEdit: true,
  onSet: vi.fn(),
  onClear: vi.fn(),
}

describe('MentionImage', () => {
  it('без картинки предлагает привязать и показывает только картинки проекта', async () => {
    render(<MentionImage {...base} />)
    expect(screen.getByText(/Картинки ещё нет/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'прикрепить картинку' }))
    const select = (await screen.findByLabelText('Картинка для упоминания')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'a1', 'a3'])
    expect(screen.queryByRole('option', { name: 'письмо.pdf' })).toBeNull()
  })

  it('прикрепляет выбранную картинку и отвязывает привязанную', async () => {
    const onSet = vi.fn()
    const onClear = vi.fn()
    render(<MentionImage {...base} onSet={onSet} onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'прикрепить картинку' }))
    const select = (await screen.findByLabelText('Картинка для упоминания')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))
    fireEvent.change(select, { target: { value: 'a3' } })
    fireEvent.click(screen.getByRole('button', { name: 'прикрепить' }))
    expect(onSet).toHaveBeenCalledWith('a3')

    cleanup()
    render(<MentionImage {...base} assetId="a3" onSet={onSet} onClear={onClear} />)
    const preview = screen.getByAltText(/Анна в кадре «Пролог»/) as HTMLImageElement
    expect(preview.getAttribute('src')).toBe('blob:a3')
    fireEvent.click(screen.getByRole('button', { name: 'отвязать' }))
    expect(onClear).toHaveBeenCalled()
  })

  it('читателю кнопок нет, но картинка видна', () => {
    render(<MentionImage {...base} canEdit={false} assetId="a1" />)
    expect(screen.queryByRole('button', { name: 'отвязать' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'прикрепить картинку' })).toBeNull()
    expect(screen.getByAltText(/Анна в кадре/)).toBeTruthy()
  })

  it('без картинки у читателя — честная подпись, а не пустота', () => {
    render(<MentionImage {...base} canEdit={false} />)
    expect(screen.getByText('Картинка не привязана.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  /**
   * 0.122.0: подписи картинки — из словаря. Альтернативный текст тоже: его читает скринридер,
   * и на английском интерфейсе он не должен оставаться русским. Имя карточки и кадра — данные.
   */
  it('на английском подписи и альтернативный текст переведены', async () => {
    setLang('en')
    render(<MentionImage {...base} assetId="a3" />)
    expect(screen.getByAltText('Анна in the frame "Пролог"')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'replace the image' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'detach' })).toBeTruthy()

    // Без названия кадра — английская подстановка, а не пустые кавычки.
    cleanup()
    render(<MentionImage {...base} assetId="a3" eventTitle="" />)
    expect(screen.getByAltText('Анна in the frame "untitled"')).toBeTruthy()

    cleanup()
    render(<MentionImage {...base} canEdit={false} />)
    expect(screen.getByText('No image attached.')).toBeTruthy()
  })
})
