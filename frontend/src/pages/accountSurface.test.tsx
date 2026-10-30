import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PeoplePage } from './PeoplePage'
import { ProfileCard } from '../components/account/ProfileCard'
import { LoginHistory } from '../components/account/LoginHistory'
import { setLang } from '../store/lang'

/**
 * Резиденты, профиль и журнал входов по-английски (0.128.0).
 *
 * Проверяем подписи, а не данные: имя человека, ник и резюме остаются как их написали.
 * Сеть подменена: каталог резидентов, профиль и журнал входов приходят готовыми ответами.
 */

vi.mock('../api/people', () => ({
  PEOPLE_PAGE_SIZE: 24,
  listPeople: async () => ({
    items: [
      {
        id: 'u2',
        username: 'anna.design',
        display_name: 'Анна',
        bio: '',
        crafts: ['Диалоги'],
        public_stories: 2,
        relation: 'none',
      },
    ],
    total: 1,
  }),
  getPerson: async () => ({ stories: [] }),
}))

vi.mock('../api/coauthors', () => ({
  inviteCoauthor: async () => undefined,
  normalizeUsername: (value: string) => value.trim().toLowerCase(),
  validUsername: () => true,
}))

vi.mock('../api/auth', () => ({
  listLogins: async () => ({ attempts: [], retentionDays: 30 }),
  updateProfile: async () => ({}),
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

describe('профиль и резиденты — язык', () => {
  it('резиденты по-русски: заголовок, поиск и счётчик', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PeoplePage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Резиденты')).toBeTruthy()
    expect(screen.getByPlaceholderText('Поиск по нику (@nick) или имени')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Найдено: 1/)).toBeTruthy())
  })

  it('резиденты по-английски: подписи, счётчик и форма с числом', async () => {
    setLang('en')
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PeoplePage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Residents')).toBeTruthy()
    expect(screen.getByPlaceholderText('Search by nick (@nick) or name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Find' })).toBeTruthy()
    // Число и слово собираются вместе: «Found: 1 resident».
    await waitFor(() => expect(screen.getByText(/Found: 1 resident/)).toBeTruthy())
    // Данные человека не переводим.
    expect(screen.getByText('Анна')).toBeTruthy()
    expect(screen.getByText('has not told about themselves yet')).toBeTruthy()
  })

  it('карточка профиля по-английски', async () => {
    setLang('en')
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ProfileCard />
      </MemoryRouter>,
    )
    expect(await screen.findByText('How people find you')).toBeTruthy()
    expect(screen.getByLabelText('Your nick')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save the profile' })).toBeTruthy()
  })

  it('журнал входов по-английски: пустое состояние', async () => {
    setLang('en')
    render(<LoginHistory />)
    expect(await screen.findByText('Recent sign-ins')).toBeTruthy()
    expect(screen.getByText(/Sign-ins to the account will appear here/)).toBeTruthy()
  })
})
