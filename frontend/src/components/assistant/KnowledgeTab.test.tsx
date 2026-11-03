import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KnowledgeTab } from './KnowledgeTab'
import { setLang } from '../../store/lang'

/**
 * Вкладка «Знания» (0.149.0).
 *
 * Проверяем то, ради чего она существует: знания видны списком с пометками, поиск идёт по
 * серверу, новое знание сохраняется, а срок хранения бесед меняет только владелец. Ошибки в
 * любом из этих мест тихие: список просто остался бы пустым, а автоочистка — включённой.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  tags: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  settings: vi.fn(),
  retention: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../api/assistant', () => ({
  listAIKnowledge: mocks.list,
  listAIKnowledgeTags: mocks.tags,
  getAIKnowledge: mocks.get,
  createAIKnowledge: mocks.create,
  updateAIKnowledge: mocks.update,
  deleteAIKnowledge: mocks.remove,
  getAISettings: mocks.settings,
  setAIRetention: mocks.retention,
}))

vi.mock('../../api/client', () => ({
  serverErrorMessage: mocks.error,
}))

vi.mock('../MarkdownBlock', () => ({
  MarkdownBlock: ({ source }: { source: string }) => <p data-markdown>{source}</p>,
}))

const ITEM = {
  id: 'k1',
  title: 'Решения по миру',
  summary: 'драконы спят, магия уходит',
  tags: ['канон', 'драконы'],
  chars: 120,
  authorName: 'Нестор',
  createdAt: '2026-03-01T10:00:00Z',
  updatedAt: '2026-03-01T10:00:00Z',
}

const SETTINGS = {
  agentName: 'Нестор',
  agentId: 'a1',
  role: '',
  roleTitle: '',
  roleHint: '',
  instructions: '',
  enabled: true,
  canEdit: true,
  member: true,
  roles: [],
  generation: 'auto',
  imageStyle: '',
  imageNegative: '',
  capabilities: { text: true, images: false, generation: 'auto', imageNote: '', imageStyle: '' },
  generations: [],
  imageAvailable: false,
  imageNote: '',
  retentionDays: 0,
  canUseKnowledge: true,
  retentionDue: 0,
  retentionNextDays: 0,
}

beforeEach(() => {
  setLang('ru')
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.list.mockResolvedValue([ITEM])
  mocks.tags.mockResolvedValue([{ tag: 'канон', count: 3 }])
  mocks.settings.mockResolvedValue(SETTINGS)
  mocks.error.mockResolvedValue(null)
  mocks.create.mockResolvedValue({ ...ITEM, id: 'k2', title: 'Новое знание' })
  mocks.retention.mockResolvedValue({ ...SETTINGS, retentionDays: 30 })
  mocks.remove.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('KnowledgeTab', () => {
  it('показывает знания с пометкой, размером и автором', async () => {
    render(<KnowledgeTab projectId="p1" visible />)
    expect(await screen.findByText('Решения по миру')).toBeTruthy()
    expect(screen.getByText('драконы спят, магия уходит')).toBeTruthy()
    // Размер и автор — часть ориентирования в списке: «сто двадцать знаков · … · Нестор».
    const item = document.querySelector('[data-knowledge-item="k1"]') as HTMLElement
    expect(item.textContent).toContain('120')
    expect(item.textContent).toContain('Нестор')
  })

  it('пустой список объясняет, откуда знания берутся', async () => {
    mocks.list.mockResolvedValue([])
    render(<KnowledgeTab projectId="p1" visible />)
    expect(await screen.findByText(/Пока нет знаний/)).toBeTruthy()
  })

  it('поиск уходит на сервер, а не фильтрует только загруженное', async () => {
    render(<KnowledgeTab projectId="p1" visible />)
    await screen.findByText('Решения по миру')
    const search = document.querySelector('[data-knowledge-search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'драконы' } })
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('p1', 'драконы'))
  })

  it('создаёт знание с заголовком и текстом', async () => {
    render(<KnowledgeTab projectId="p1" visible />)
    await screen.findByText('Решения по миру')
    fireEvent.click(screen.getByRole('button', { name: 'Новое' }))
    fireEvent.change(document.querySelector('[data-knowledge-title]') as HTMLInputElement, {
      target: { value: 'Канон' },
    })
    fireEvent.change(document.querySelector('[data-knowledge-body]') as HTMLTextAreaElement, {
      target: { value: 'Тезис' },
    })
    fireEvent.change(document.querySelector('[data-knowledge-tags]') as HTMLInputElement, {
      target: { value: 'Драконы, канон' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('p1', {
        title: 'Канон',
        summary: '',
        body: 'Тезис',
        tags: ['Драконы', 'канон'],
      }),
    )
  })

  it('срок хранения меняется только владельцу', async () => {
    render(<KnowledgeTab projectId="p1" visible />)
    const select = (await waitFor(() => {
      const found = document.querySelector('[data-knowledge-retention]') as HTMLSelectElement | null
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })) as HTMLSelectElement
    expect(select.disabled).toBe(false)

    fireEvent.change(select, { target: { value: '30' } })
    await waitFor(() => expect(mocks.retention).toHaveBeenCalledWith('p1', 30))
  })

  it('редактору срок хранения недоступен', async () => {
    mocks.settings.mockResolvedValue({ ...SETTINGS, canEdit: false })
    render(<KnowledgeTab projectId="p1" visible />)
    const select = (await waitFor(() => {
      const found = document.querySelector('[data-knowledge-retention]') as HTMLSelectElement | null
      expect(found).not.toBeNull()
      return found as HTMLSelectElement
    })) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(screen.getByText(/владелец проекта/)).toBeTruthy()
  })

  it('удаление — в два нажатия: одно не стирает знание', async () => {
    render(<KnowledgeTab projectId="p1" visible />)
    await screen.findByText('Решения по миру')
    const del = document.querySelector('[data-knowledge-delete="k1"]') as HTMLButtonElement
    fireEvent.click(del)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(del.textContent).toContain('Точно удалить?')
    fireEvent.click(del)
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'k1'))
  })

  /**
   * Знания — черновые исследования соавторов (0.150.0). Читатель проекта их не видит, и
   * вкладка обязана это сказать, а не показать пустой список или ошибку 403.
   */
  it('читателю проекта знания не показывает и не грузит', async () => {
    mocks.settings.mockResolvedValue({ ...SETTINGS, canUseKnowledge: false })
    render(<KnowledgeTab projectId="p1" visible />)
    expect(await screen.findByText(/только соавторы/)).toBeTruthy()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(document.querySelector('[data-knowledge-retention]')).toBeNull()
  })

  it('подсказывает метки проекта в форме', async () => {
    render(<KnowledgeTab projectId='p1' visible />)
    await screen.findByText('Решения по миру')
    await waitFor(() => expect(mocks.tags).toHaveBeenCalledWith('p1'))
    // Подсказка живёт в форме: до её открытия списка меток в разметке нет.
    fireEvent.click(screen.getByRole('button', { name: 'Новое' }))
    const options = await waitFor(() => {
      const found = document.querySelectorAll('[data-knowledge-tag-options] option')
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    expect(options[0].getAttribute('value')).toBe('канон')
  })

  it('предупреждает, сколько бесед удалит автоочистка', async () => {
    mocks.settings.mockResolvedValue({
      ...SETTINGS,
      retentionDays: 90,
      retentionDue: 4,
      retentionNextDays: 3,
    })
    render(<KnowledgeTab projectId="p1" visible />)
    const warning = await waitFor(() => {
      const found = document.querySelector('[data-knowledge-retention-warning]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(warning.textContent).toContain('4')
  })
})
