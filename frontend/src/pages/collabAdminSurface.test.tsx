import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CoauthorsPage } from './CoauthorsPage'
import { StoragePanel } from '../components/admin/StoragePanel'
import { NotificationBell } from '../components/NotificationBell'
import { PresenceBar } from '../components/collab/PresenceBar'
import { setLang } from '../store/lang'

/**
 * Соавторы, хранилище, уведомления и присутствие по-английски (0.129.0).
 *
 * Проверяем подписи, а не данные: имена людей, названия проектов и специализации остаются
 * как есть. Сеть подменена: каталог соавторов, отчёт о хранилище и уведомления приходят
 * готовыми ответами.
 */

vi.mock('../api/coauthors', () => ({
  listCoauthors: async () => ({ coauthors: [], incoming: [], outgoing: [] }),
  searchUsers: async () => [],
  inviteCoauthor: async () => undefined,
  decideCoauthor: async () => undefined,
  removeCoauthor: async () => undefined,
  updateCoauthor: async () => undefined,
  normalizeUsername: (value: string) => value.trim().toLowerCase(),
  validUsername: () => true,
}))

vi.mock('../api/admin', () => ({
  getStorageReport: async () => ({
    db_bytes: 1024,
    snapshot_bytes: 2048,
    projection_bytes: 512,
    asset_bytes: 4096,
    disk_bytes: 8192,
    projects: 1,
    scan_ms: 12,
    scanned_at: '2026-10-30T00:00:00Z',
    orphan_files: 0,
    orphan_bytes: 0,
    pending_files: 0,
    missing_files: 0,
    projects_usage: [],
    tables: [],
  }),
  sweepOrphans: vi.fn(),
  recompressAssets: vi.fn(),
}))

vi.mock('../api/comments', () => ({
  projectsWithUnseen: async () => [],
}))

vi.mock('../api/chat', () => ({
  chatUnseen: async () => [],
}))

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) =>
    selector({ user: { id: 'u1', display_name: 'Анна', username: 'anna.design' } }),
}))

afterEach(() => {
  cleanup()
  setLang('ru')
})

beforeEach(() => {
  setLang('ru')
})

describe('соавторы, хранилище и уведомления — язык', () => {
  it('соавторы по-русски: заголовок и поиск', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <CoauthorsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Соавторы')).toBeTruthy()
    expect(screen.getByPlaceholderText('@nick или имя')).toBeTruthy()
  })

  it('соавторы по-английски: подписи и пустое состояние', async () => {
    setLang('en')
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <CoauthorsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Co-authors')).toBeTruthy()
    expect(screen.getByText('Your profile')).toBeTruthy()
    expect(screen.getByText('Find a person')).toBeTruthy()
    expect(screen.getByPlaceholderText('@nick or a name')).toBeTruthy()
  })

  it('хранилище по-английски: заголовок и подписи строк', async () => {
    setLang('en')
    render(<StoragePanel />)
    expect(await screen.findByText('Storage')).toBeTruthy()
    expect(screen.getByText('Database')).toBeTruthy()
    expect(screen.getByText('Files on disk')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh the report' })).toBeTruthy()
  })

  it('уведомления по-английски: пустое состояние', async () => {
    setLang('en')
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <NotificationBell />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('New comments')).toBeTruthy())
  })

  it('присутствие по-английски: заголовок инициатора', async () => {
    setLang('en')
    render(
      <MemoryRouter>
        <PresenceBar
          peers={[
            {
              userId: 'u2',
              clientId: 'c2',
              name: 'Борис',
              initials: 'Б',
              color: '#111111',
              eventId: null,
              typing: false,
            },
          ]}
          events={[]}
        />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Who is in the project now')).toBeTruthy()
    expect(screen.getByText('In the project:')).toBeTruthy()
    // Имя человека — данные.
    expect(screen.getByText('Борис')).toBeTruthy()
  })
})
