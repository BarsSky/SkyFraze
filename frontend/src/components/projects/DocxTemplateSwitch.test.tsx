import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DocxTemplateSwitch } from './DocxTemplateSwitch'

/**
 * Переключатель оформления DOCX в меню «Книга» (0.93.1).
 *
 * Смысл: оформление выбирают ПЕРЕД скачиванием, и видно, что применится. Проверяем: активный
 * шаблон выбран, переключение зовёт сервер, читателю менять нельзя, без шаблонов — честная
 * подпись, а ошибка загрузки списка не ломает меню выгрузки.
 */

const listDocxTemplates = vi.fn()
const activateDocxTemplate = vi.fn()

vi.mock('../../api/docxTemplates', () => ({
  listDocxTemplates: (projectId: string) => listDocxTemplates(projectId),
  activateDocxTemplate: (projectId: string, id: string) => activateDocxTemplate(projectId, id),
}))

const template = (id: string, name: string, active: boolean) => ({
  id,
  name,
  filename: `${name}.docx`,
  size: 1234,
  is_active: active,
  uploaded_at: '2026-01-01T00:00:00Z',
  styles: [],
  page: {},
  report: { has_placeholder: true, has_numbering: false, styles: [], mapping: {}, warnings: [], page: {} },
  placeholder: { found: true },
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DocxTemplateSwitch', () => {
  it('показывает активный шаблон и переключает его', async () => {
    listDocxTemplates.mockResolvedValue([template('t1', 'рукопись', true), template('t2', 'самиздат', false)])
    activateDocxTemplate.mockResolvedValue([template('t1', 'рукопись', false), template('t2', 'самиздат', true)])

    render(<DocxTemplateSwitch projectId="p1" canEdit />)
    const select = (await screen.findByLabelText('Оформление')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(2))
    expect(listDocxTemplates).toHaveBeenCalledWith('p1')
    expect(select.value).toBe('t1')
    expect(select.disabled).toBe(false)

    fireEvent.change(select, { target: { value: 't2' } })
    await waitFor(() => expect(activateDocxTemplate).toHaveBeenCalledWith('p1', 't2'))
    // После переключения активным показан новый шаблон: скачивание соберётся им.
    await waitFor(() => expect((screen.getByLabelText('Оформление') as HTMLSelectElement).value).toBe('t2'))
  })

  it('читателю переключатель виден, но выключен', async () => {
    listDocxTemplates.mockResolvedValue([template('t1', 'рукопись', true), template('t2', 'самиздат', false)])
    render(<DocxTemplateSwitch projectId="p1" canEdit={false} />)
    const select = (await screen.findByLabelText('Оформление')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(2))
    expect(select.disabled).toBe(true)
  })

  it('один шаблон — менять нечего, переключатель выключен', async () => {
    listDocxTemplates.mockResolvedValue([template('t1', 'рукопись', true)])
    render(<DocxTemplateSwitch projectId="p1" canEdit />)
    const select = (await screen.findByLabelText('Оформление')) as HTMLSelectElement
    expect(select.disabled).toBe(true)
  })

  it('шаблонов нет — честная подпись вместо пустого выбора', async () => {
    listDocxTemplates.mockResolvedValue([])
    render(<DocxTemplateSwitch projectId="p1" canEdit />)
    await waitFor(() => expect(screen.getByText(/Шаблон оформления не загружен/)).toBeTruthy())
    expect(screen.queryByLabelText('Оформление')).toBeNull()
  })

  it('ошибка загрузки списка не ломает меню выгрузки', async () => {
    listDocxTemplates.mockRejectedValue(new Error('403'))
    render(<DocxTemplateSwitch projectId="p1" canEdit />)
    await waitFor(() => expect(screen.getByText(/Шаблон оформления не загружен/)).toBeTruthy())
  })
})
