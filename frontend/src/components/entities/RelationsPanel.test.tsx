import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RelationsPanel, numberRows } from './RelationsPanel'
import type { FlatEventNode } from '../../api/events'
import { OPEN_FRAME_EVENT } from '../../lib/openFrame'

/**
 * Область «Связи» (0.79.0): всё про карточки мира — в одном разделе, отдельно от редакторов.
 *
 * Что закрепляем: раздел считает статистику по проекции (кадры, главы), собирает граф и
 * карточки, объясняет пустое состояние, и переход из хронологии просит редактор открыть кадр
 * событием, а не колбэком через страницу.
 */

const mocks = vi.hoisted(() => ({ rows: vi.fn(), entities: vi.fn(), links: vi.fn(), types: vi.fn() }))

vi.mock('../../api/events', () => ({ listEventRows: mocks.rows }))

vi.mock('../../api/entities', async () => {
  const actual = await vi.importActual<typeof import('../../api/entities')>('../../api/entities')
  return { ...actual, listEntities: mocks.entities, listEntityLinks: mocks.links }
})

vi.mock('../../api/entityTypes', async () => {
  const actual = await vi.importActual<typeof import('../../api/entityTypes')>(
    '../../api/entityTypes',
  )
  return {
    ...actual,
    listEntityTypes: mocks.types,
    createEntityType: vi.fn(),
  }
})

const eventRow = (over: Partial<FlatEventNode>): FlatEventNode => ({
  id: 'e1',
  parent_id: null,
  title: 'Пролог',
  body: 'Аня стоит на пороге.',
  event_date: '2026-03-02',
  ...over,
})

const card = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  kind: 'character',
  name: 'Аня',
  aliases: ['Аню'],
  description: '',
  color: '',
  created_at: '',
  updated_at: '',
  ...over,
})

beforeEach(() => {
  mocks.rows.mockReset().mockResolvedValue([
    eventRow({ id: 'f1', title: 'Пролог', body: 'Аня стоит на пороге.' }),
    eventRow({ id: 'f2', parent_id: 'f1', title: 'Сцена', body: 'Аня уходит.', event_date: null }),
  ])
  mocks.entities.mockReset().mockResolvedValue([card(), card({ id: 'c2', kind: 'place', name: 'Земля', aliases: [] })])
  mocks.links.mockReset().mockResolvedValue([])
  // Типы карточек: три стартовых есть в каждом проекте (0.81.0).
  mocks.types.mockReset().mockResolvedValue([
    { key: 'character', title: 'Персонаж', color: '', icon: '', position: 0, is_default: true, created_at: '' },
    { key: 'place', title: 'Место', color: '', icon: '', position: 1, is_default: true, created_at: '' },
    { key: 'theme', title: 'Тема', color: '', icon: '', position: 2, is_default: true, created_at: '' },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RelationsPanel', () => {
  it('показывает статистику по проекции: карточки, связи, кадры, главы', async () => {
    render(<RelationsPanel projectId="p1" canEdit />)
    expect(await screen.findByText(/карточек: 2 · связей: 0 · кадров: 2 · глав: 1/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Связи' })).toBeTruthy()
  })

  it('собирает граф, карточки и матрицу в одном разделе', async () => {
    const { container } = render(<RelationsPanel projectId="p1" canEdit />)
    await screen.findByText(/кадров: 2/)
    expect(container.querySelector('[data-relations]')).toBeTruthy()
    expect(container.querySelector('[data-entity-graph]')).toBeTruthy()
    expect(container.querySelector('[data-entities]')).toBeTruthy()
    // Матрица появляется, когда есть и главы, и упоминания.
    expect(container.querySelector('[data-entity-matrix]')).toBeTruthy()
  })

  it('без карточек объясняет, с чего начать', async () => {
    mocks.entities.mockResolvedValue([])
    mocks.links.mockResolvedValue([])
    render(<RelationsPanel projectId="p1" canEdit />)
    // Подсказка раздела и подсказка панели карточек говорят об одном — ищем обе.
    expect((await screen.findAllByText(/Карточек пока нет/)).length).toBeGreaterThan(0)
    expect(document.querySelector('[data-relations-empty]')).toBeTruthy()
    // Панель карточек при этом на месте: создавать карточку нужно именно здесь.
    expect(document.querySelector('[data-entities]')).toBeTruthy()
  })

  it('читателю кнопок правки нет, но раздел виден', async () => {
    render(<RelationsPanel projectId="p1" canEdit={false} />)
    await screen.findByText(/кадров: 2/)
    expect(screen.queryByRole('button', { name: /Добавить/ })).toBeNull()
  })

  it('переход из хронологии просит редактор открыть кадр событием', async () => {
    const seen: Array<{ frameId: string }> = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(OPEN_FRAME_EVENT, listener)
    render(<RelationsPanel projectId="p1" canEdit />)
    await screen.findByText(/кадров: 2/)

    // Действия карточки — в меню «⋮» (0.102.0): сначала открываем его, потом выбираем пункт.
    fireEvent.click(screen.getByLabelText('Действия с карточкой Аня'))
    fireEvent.click(screen.getByLabelText('Где встречается Аня'))
    fireEvent.click(await screen.findByText('Пролог'))
    await waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].frameId).toBe('f1')
    window.removeEventListener(OPEN_FRAME_EVENT, listener)
  })

  /**
   * 0.87.0: переход идёт ПРОПСОМ страницы, а не событием.
   *
   * Отчёт: «переходы по матрице связей перестали работать по нажатию». Причина — панель
   * редакторов с 0.83.0 монтируется только на своей вкладке, и событие `open-frame` из «Связей»
   * слышать было некому. Теперь страница переключает вкладку и передаёт просьбу пропсом.
   */
  it('клетка матрицы раскрывает карточку и отдаёт переход странице', async () => {
    const onOpenFrame = vi.fn()
    render(<RelationsPanel projectId="p1" canEdit onOpenFrame={onOpenFrame} />)
    await screen.findByText(/кадров: 2/)

    // Матрица раскрыта в разделе; клетка «Аня × Пролог» содержит число упоминаний.
    const cell = document.querySelector('[data-matrix-cell]') as HTMLElement | null
    expect(cell).not.toBeNull()
    fireEvent.click(cell as HTMLElement)
    const card = await screen.findByRole('region', { name: /Упоминания «Аня»/ })
    expect(card.textContent).toContain('Пролог')

    fireEvent.click(screen.getByRole('button', { name: 'К проекту' }))
    expect(onOpenFrame).toHaveBeenCalledWith('f1', expect.objectContaining({ entityName: 'Аня' }), 'project')
  })

  it('«К редактированию» в карточке матрицы уходит странице с местом «editors»', async () => {
    const onOpenFrame = vi.fn()
    render(<RelationsPanel projectId="p1" canEdit onOpenFrame={onOpenFrame} />)
    await screen.findByText(/кадров: 2/)
    fireEvent.click(document.querySelector('[data-matrix-cell]') as HTMLElement)
    await screen.findByRole('region', { name: /Упоминания «Аня»/ })
    fireEvent.click(screen.getByRole('button', { name: 'К редактированию' }))
    expect(onOpenFrame).toHaveBeenCalledWith('f1', expect.objectContaining({ entityName: 'Аня' }), 'editors')
  })
})

describe('numberRows', () => {
  it('нумерует кадры обходом дерева: 01, 01.1, 02', () => {
    const rows = numberRows([
      { id: 'a', parentId: null, title: 'Глава 1' },
      { id: 'a1', parentId: 'a', title: 'Сцена' },
      { id: 'b', parentId: null, title: 'Глава 2' },
    ])
    expect(rows.map((row) => `${row.id}:${row.number}`)).toEqual(['a:01', 'a1:01.1', 'b:02'])
    expect(rows[0].isChapter).toBe(true)
    expect(rows[1].isChapter).toBe(false)
    // Порядок — это место в дереве: по нему хронология ставит кадры без даты.
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2])
  })

  it('дата приводится к ГГГГ-ММ-ДД, отсутствие даты — пустая строка', () => {
    const rows = numberRows([
      { id: 'a', parentId: null, title: 'Глава', event_date: '2026-03-02T10:00:00Z' },
      { id: 'b', parentId: null, title: 'Без даты', event_date: null },
    ])
    expect(rows[0].date).toBe('2026-03-02')
    expect(rows[1].date).toBe('')
  })
})
