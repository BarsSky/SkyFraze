import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationBell } from './NotificationBell'

/**
 * Колокольчик в шапке.
 *
 * Проверяем то, ради чего он существует: счётчик виден, он говорит, В КАКОМ проекте ждут
 * замечания, ссылка ведёт в проект, пустое состояние честное, а сбой запроса не ломает
 * шапку. Обновление по переходу между страницами проверяется отдельно — это единственный
 * момент, когда счётчик мог уменьшиться (обсуждение открыли).
 */

const mocks = vi.hoisted(() => ({ projects: vi.fn() }))

vi.mock('../api/comments', () => ({
  // Модуль отдаёт и типы, и разбор — компоненту нужен только этот вызов.
  projectsWithUnseen: mocks.projects,
}))

const row = (over: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  title: 'Рукопись',
  unread: 3,
  lastAt: '2026-10-26T08:00:00Z',
  ...over,
})

function renderBell(initial = '/projects') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <NotificationBell />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mocks.projects.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NotificationBell', () => {
  it('без замечаний счётчика нет, и об этом честно сказано в панели', async () => {
    renderBell()
    await waitFor(() => expect(mocks.projects).toHaveBeenCalled())
    const bell = screen.getByRole('button', { name: 'Новые замечания' })
    expect(bell).toBeTruthy()
    expect(document.querySelector('[data-notify-count]')).toBeNull()

    fireEvent.click(bell)
    expect(screen.getByText('Новых замечаний нет')).toBeTruthy()
  })

  it('счётчик — сумма по проектам, и в панели видно, в каком проекте сколько', async () => {
    mocks.projects.mockResolvedValue([
      row({ projectId: 'p1', title: 'Рукопись', unread: 3 }),
      row({ projectId: 'p2', title: 'Черновик', unread: 2 }),
    ])
    renderBell()
    const bell = await screen.findByRole('button', { name: 'Новые замечания: 5' })
    expect(document.querySelector('[data-notify-count]')?.getAttribute('data-notify-count')).toBe('5')

    fireEvent.click(bell)
    const items = document.querySelectorAll('[data-notify-item]')
    expect(items.length).toBe(2)
    expect(screen.getByText('Рукопись')).toBeTruthy()
    expect(screen.getByText('Черновик')).toBeTruthy()
    // Склонение: «3 новых», «1 новое» — по числу, а не всегда «новых».
    expect(screen.getByText('3 новых')).toBeTruthy()
  })

  it('склоняет «новое / новых»', async () => {
    mocks.projects.mockResolvedValue([row({ unread: 1 })])
    renderBell()
    fireEvent.click(await screen.findByRole('button', { name: 'Новые замечания: 1' }))
    expect(screen.getByText('1 новое')).toBeTruthy()
  })

  it('ссылка ведёт в проект и закрывает панель', async () => {
    mocks.projects.mockResolvedValue([row()])
    renderBell()
    fireEvent.click(await screen.findByRole('button', { name: /Новые замечания/ }))
    const link = screen.getByRole('link', { name: /Рукопись/ })
    expect(link.getAttribute('href')).toBe('/projects/p1')
    fireEvent.click(link)
    await waitFor(() => expect(document.querySelector('[data-notify-panel]')).toBeNull())
  })

  it('закрывается по Esc и клику мимо', async () => {
    mocks.projects.mockResolvedValue([row()])
    renderBell()
    const bell = await screen.findByRole('button', { name: /Новые замечания/ })
    fireEvent.click(bell)
    expect(document.querySelector('[data-notify-panel]')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-notify-panel]')).toBeNull())

    fireEvent.click(bell)
    expect(document.querySelector('[data-notify-panel]')).toBeTruthy()
    fireEvent.click(document.body)
    await waitFor(() => expect(document.querySelector('[data-notify-panel]')).toBeNull())
  })

  it('больше 99 показывает «99+»: важна не точность, а «много»', async () => {
    mocks.projects.mockResolvedValue([row({ unread: 150 })])
    renderBell()
    await screen.findByRole('button', { name: 'Новые замечания: 150' })
    expect(document.querySelector('[data-notify-count]')?.textContent).toBe('99+')
  })

  it('сбой запроса не ломает шапку: колокольчик просто без счётчика', async () => {
    mocks.projects.mockRejectedValue(new Error('нет связи'))
    renderBell()
    const bell = await screen.findByRole('button', { name: 'Новые замечания' })
    expect(bell).toBeTruthy()
    expect(document.querySelector('[data-notify-count]')).toBeNull()
  })
})
