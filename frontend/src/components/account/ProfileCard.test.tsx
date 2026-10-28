import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProfileCard } from './ProfileCard'

/**
 * «Как вас найти» — блок профиля (0.99.0).
 *
 * Блок переехал со страницы «Соавторы» на свою вкладку «Профиль»: отчёт «нету вкладки пользователя,
 * всё, что относится ко входу пользователя, в Соавторах». Тесты держат две вещи: блок сохраняет
 * ТОЛЬКО изменённое (пустое значение — осознанная очистка, а не «не трогать») и занятый ник даёт
 * понятную ошибку, а не «409».
 */

const mocks = vi.hoisted(() => ({ updateProfile: vi.fn() }))

vi.mock('../../api/auth', () => ({
  updateProfile: (...args: unknown[]) => mocks.updateProfile(...args),
}))

vi.mock('../../components/account/TwoFactorSettings', () => ({
  // Второй фактор проверяется своим тестом: здесь важно, что блок профиля его содержит.
  TwoFactorSettings: () => <div data-testid="two-factor" />,
}))

let currentUser: Record<string, unknown> = {
  id: 'u1',
  email: 'me@example.com',
  display_name: 'Аня',
  username: 'anya',
  bio: 'Пишу про море',
  crafts: ['prose'],
  discoverable: true,
  notify_comments: false,
}

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown; setUser: unknown }) => unknown) =>
    selector({ user: currentUser, setUser: vi.fn() }),
}))

beforeEach(() => {
  currentUser = {
    id: 'u1',
    email: 'me@example.com',
    display_name: 'Аня',
    username: 'anya',
    bio: 'Пишу про море',
    crafts: ['prose'],
    discoverable: true,
    notify_comments: false,
  }
  mocks.updateProfile.mockReset().mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('ProfileCard', () => {
  it('показывает имя, ник, резюме и галочки — и содержит блок входа', () => {
    render(<ProfileCard />)
    expect((screen.getByLabelText('Ваше имя') as HTMLInputElement).value).toBe('Аня')
    expect((screen.getByLabelText('Ваш ник') as HTMLInputElement).value).toBe('anya')
    expect((screen.getByLabelText('О себе') as HTMLTextAreaElement).value).toBe('Пишу про море')
    expect(screen.getByText(/Показывать меня в списке резидентов/)).toBeTruthy()
    expect(screen.getByTestId('two-factor')).toBeTruthy()
  })

  it('сохраняет только изменённое: имя поменяли — ник не уходит', async () => {
    render(<ProfileCard />)
    fireEvent.change(screen.getByLabelText('Ваше имя'), { target: { value: 'Анна' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ display_name: 'Анна' }))
    expect(await screen.findByText('Сохранено')).toBeTruthy()
  })

  it('пустое резюме — осознанная очистка, а не «не трогать»', async () => {
    render(<ProfileCard />)
    fireEvent.change(screen.getByLabelText('О себе'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ bio: '' }))
  })

  it('галочка писем уходит на сервер отдельным полем', async () => {
    render(<ProfileCard />)
    fireEvent.click(screen.getByLabelText(/Присылать замечания на почту/))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith({ notify_comments: true }))
  })

  it('без изменений кнопка неактивна: незачем ходить на сервер', () => {
    render(<ProfileCard />)
    expect(screen.getByRole('button', { name: 'Сохранить профиль' })).toBeDisabled()
  })

  it('занятый ник объясняется словами, а не кодом', async () => {
    mocks.updateProfile.mockRejectedValue(new Error('409'))
    render(<ProfileCard />)
    fireEvent.change(screen.getByLabelText('Ваш ник'), { target: { value: 'zanyat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
    expect(await screen.findByText('Этот ник уже занят — попробуйте другой')).toBeTruthy()
  })
})
