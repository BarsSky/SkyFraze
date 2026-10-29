import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjectSettingsPage } from './ProjectSettingsPage'
import { setLang } from '../store/lang'

/**
 * Настройки проекта (0.124.0): подписи участников, соавторов, оформления DOCX и шаблона
 * проекта — из словаря.
 *
 * Страница не была покрыта тестами вовсе; здесь закреплено главное, ради чего она переведена:
 * английский интерфейс не оставляет русских подписей, а данные людей и проектов (имена, email,
 * названия шаблонов) не переводятся. Сеть подменена целиком: проверяем разметку, а не запросы.
 */

vi.mock('../api/projects', () => ({
  getProject: async () => ({ id: 'p1', title: 'Аудит', role: 'owner' }),
  listProjects: async () => [],
  createProject: async () => ({}),
  deleteProject: async () => undefined,
  publishProject: async () => ({}),
}))

vi.mock('../api/teams', () => ({
  listMembers: async () => [
    {
      project_id: 'p1',
      user_id: 'u1',
      role: 'owner',
      added_at: '',
      display_name: 'Аня',
      username: 'anya',
      email: 'anya@example.com',
    },
    {
      project_id: 'p1',
      user_id: 'u2',
      role: 'editor',
      added_at: '',
      display_name: 'Борис',
      username: 'boris',
      email: 'boris@example.com',
    },
  ],
  addMember: async () => undefined,
  removeMember: async () => undefined,
  invite: async () => ({ token: 't', expires_at: '2026-11-01T00:00:00Z' }),
  searchUsers: async () => [],
}))

vi.mock('../api/coauthors', () => ({
  listCoauthors: async () => ({ coauthors: [], incoming: [], outgoing: [] }),
  searchUsers: async () => [],
}))

vi.mock('../api/projectTemplate', () => ({
  getProjectTemplate: async () => ({ entity_types: [], cards: [] }),
  applyProjectTemplate: async () => ({ message: '', changed: 0 }),
  parseTemplate: () => ({}),
  templateFileName: (title: string) => `${title}.json`,
}))

vi.mock('../api/docxTemplates', async () => {
  const actual = await vi.importActual<typeof import('../api/docxTemplates')>('../api/docxTemplates')
  return {
    ...actual,
    listDocxTemplates: async () => [],
    uploadDocxTemplate: async () => ({}),
    activateDocxTemplate: async () => [],
    deleteDocxTemplate: async () => [],
    downloadDocxSample: async () => 'sample.docx',
  }
})

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) =>
    selector({ user: { id: 'u1', email: 'anya@example.com', display_name: 'Аня' } }),
}))

function show() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProjectSettingsPage />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  setLang('ru')
})

describe('ProjectSettingsPage — язык', () => {
  it('русские подписи на месте: участники, роли и карточки настроек', async () => {
    show()
    expect(await screen.findByText('Участники')).toBeTruthy()
    expect(screen.getByText('Добавить соавтора')).toBeTruthy()
    expect(screen.getByText('Оформление DOCX')).toBeTruthy()
    expect(screen.getByText('Шаблон проекта')).toBeTruthy()
    // Роль — словом, а не owner/editor (в списке и в выборе роли — несколько таких слов).
    expect(screen.getAllByText('владелец').length).toBeGreaterThan(0)
    expect(screen.getAllByText('редактор').length).toBeGreaterThan(0)
  })

  it('на английском подписи переведены, а люди и проект — данные', async () => {
    setLang('en')
    show()
    expect(await screen.findByText('Members')).toBeTruthy()
    expect(screen.getByText('Add a co-author')).toBeTruthy()
    expect(screen.getByText('DOCX styling')).toBeTruthy()
    expect(screen.getByText('Project template')).toBeTruthy()
    expect(screen.getAllByText('owner').length).toBeGreaterThan(0)
    expect(screen.getAllByText('editor').length).toBeGreaterThan(0)
    // Кнопки и подсказки — из словаря.
    expect(screen.getByRole('button', { name: 'Co-authors' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'To the timeline' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'How to make a template' })).toBeTruthy()
    expect(screen.getByLabelText('DOCX template name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Upload the template' })).toBeTruthy()
    expect(screen.getByText('No templates yet.')).toBeTruthy()
    // Имена участников и email — данные человека.
    expect(screen.getByText('Аня')).toBeTruthy()
    expect(screen.getByText('@anya')).toBeTruthy()
  })
})
