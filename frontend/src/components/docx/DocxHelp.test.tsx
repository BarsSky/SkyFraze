import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DocxHelp } from './DocxHelp'
import { setLang } from '../../store/lang'

/**
 * Справка «Как сделать шаблон» (0.94.0).
 *
 * Фича выглядела нерабочей из-за отсутствия ответа на три вопроса: что положить в шаблон, что
 * программа воспринимает из текста и как называются стили. Поэтому проверяем не вёрстку, а
 * наличие ответов: плейсхолдер, имена стилей, таблица «что берётся из текста», словарь маркеров и
 * честный список того, чего шаблон не делает. Плюс — закрытие по Escape и кнопка «закрыть»:
 * окно поверх редактора, и без выхода из него человек чувствует себя запертым.
 */

const downloadDocxSample = vi.fn()

vi.mock('../../api/docxTemplates', () => ({
  downloadDocxSample: (projectId: string) => downloadDocxSample(projectId),
}))

afterEach(() => {
  setLang('ru')
  cleanup()
  vi.clearAllMocks()
})

describe('DocxHelp', () => {
  it('отвечает на главные вопросы: плейсхолдер, стили, что берётся из текста, маркеры', () => {
    render(<DocxHelp onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: /Справка по шаблону DOCX/ })).toBeTruthy()
    // Плейсхолдер — главное требование к шаблону.
    expect(screen.getAllByText(/\{\{content\}\}/).length).toBeGreaterThan(0)
    // Имена стилей, которые ищет разбор.
    expect(screen.getByText(/Heading1–Heading4/)).toBeTruthy()
    expect(screen.getByText(/ListParagraph/)).toBeTruthy()
    // Что воспринимается из текста.
    expect(screen.getByText(/Главы и под-события/)).toBeTruthy()
    expect(screen.getByText(/Картинки кадра/)).toBeTruthy()
    // Словарь маркеров — тот же, что в панели редактора.
    expect(screen.getByText('<!-- sf:pagebreak -->')).toBeTruthy()
    expect(screen.getByText('<!-- sf:toc -->')).toBeTruthy()
    expect(screen.getByText(/begin=Имя/)).toBeTruthy()
    // Честные ограничения.
    expect(screen.getByText(/не обновляет оглавление само/)).toBeTruthy()
  })

  it('скачивает пример, когда есть проект, и сообщает имя файла', async () => {
    downloadDocxSample.mockResolvedValue('skyfraze-template-example.docx')
    render(<DocxHelp projectId="p1" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Скачать пример .docx' }))
    expect(downloadDocxSample).toHaveBeenCalledWith('p1')
    await waitFor(() => expect(screen.getByText(/Скачан «skyfraze-template-example.docx»/)).toBeTruthy())
  })

  it('без проекта кнопки примера нет: скачивать некуда', () => {
    render(<DocxHelp onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Скачать пример .docx' })).toBeNull()
  })

  it('закрывается кнопкой и по Escape', () => {
    const onClose = vi.fn()
    render(<DocxHelp onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть справку' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ошибка скачивания не молчит', async () => {
    downloadDocxSample.mockRejectedValue(new Error('403'))
    render(<DocxHelp projectId="p1" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Скачать пример .docx' }))
    await waitFor(() => expect(screen.getByText(/Не удалось скачать пример/)).toBeTruthy())
  })

  /**
   * 0.124.0: вся справка — из словаря. Имена стилей Word (Title, Heading1–4, Quote, Code, Date,
   * ListParagraph) и текст маркеров не переводятся: это токены, которые человек набирает в
   * документе. Русские названия стилей в скобках на английском пустые — англоязычный Word
   * называет их иначе, и подсказка «(«Заголовок»)» там только путала бы.
   */
  it('на английском справка переведена, а имена стилей и маркеры — нет', () => {
    setLang('en')
    render(<DocxHelp projectId="p1" onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'DOCX template help' })).toBeTruthy()
    expect(screen.getByText('How to make a DOCX styling template')).toBeTruthy()
    expect(screen.getByText('What is taken from the text')).toBeTruthy()
    expect(screen.getByText('Chapters and sub-events')).toBeTruthy()
    expect(screen.getByText('Frame images')).toBeTruthy()
    expect(screen.getByText('What the template does not do')).toBeTruthy()
    expect(screen.getByText(/does not update the table of contents by itself/)).toBeTruthy()
    // Стили и маркеры — протокол, не подписи интерфейса.
    expect(screen.getByText(/Heading1–Heading4/)).toBeTruthy()
    expect(screen.getByText('<!-- sf:pagebreak -->')).toBeTruthy()
    // Русских названий стилей в скобках на английском нет.
    expect(screen.queryByText(/«Заголовок»/)).toBeNull()
  })
})
