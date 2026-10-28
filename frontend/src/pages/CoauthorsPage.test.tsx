import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CoauthorsPage } from './CoauthorsPage'

/**
 * «Соавторы» после переезда профиля (0.99.0).
 *
 * Отчёт: «нету вкладки пользователя, всё, что относится ко входу пользователя, расположено в
 * Соавторах». Профиль переехал на вкладку «Профиль», а здесь остался короткий указатель — чтобы
 * человек, который искал настройки на прежнем месте, не ушёл ни с чем.
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

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) =>
    selector({ user: { id: 'u1', email: 'me@example.com', display_name: 'Аня', username: 'anya' } }),
}))

afterEach(() => cleanup())

describe('CoauthorsPage — профиль переехал на свою вкладку', () => {
  it('не показывает форму профиля, но ведёт на вкладку «Профиль»', () => {
    render(
      <MemoryRouter>
        <CoauthorsPage />
      </MemoryRouter>,
    )
    // Формы профиля здесь больше нет: ни «Как вас найти», ни галочки писем.
    expect(screen.queryByText('Как вас найти')).toBeNull()
    expect(document.querySelector('[data-notify-comments]')).toBeNull()
    // А указатель есть, и он ведёт на /profile.
    const link = screen.getByRole('button', { name: 'Открыть профиль' }).closest('a')
    expect(link?.getAttribute('href')).toBe('/profile')
  })
})
