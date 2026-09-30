import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PeoplePage } from './PeoplePage'

/**
 * Поиск в каталоге резидентов.
 *
 * Раньше запрос уходил только по паузе после набора: человек, допечатав ник,
 * ждал. Теперь у формы есть кнопка «Найти» (и Enter — это тот же submit),
 * которая применяет запрос сразу. Подсказка про два символа и порог остаются.
 */
const mocks = vi.hoisted(() => ({ list: vi.fn(), person: vi.fn(), invite: vi.fn() }))

vi.mock('../api/people', () => ({
  listPeople: mocks.list,
  getPerson: mocks.person,
  PEOPLE_PAGE_SIZE: 20,
}))

vi.mock('../api/coauthors', () => ({ inviteCoauthor: mocks.invite }))

const page = () =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <PeoplePage />
    </MemoryRouter>,
  )

const searchInput = () => screen.getByLabelText('Поиск резидентов по нику или имени')

const lastQuery = () => mocks.list.mock.calls[mocks.list.mock.calls.length - 1][0] as { q: string }

describe('PeoplePage — поиск резидентов', () => {
  beforeEach(() => {
    mocks.list.mockReset()
    mocks.list.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 })
    mocks.invite.mockReset()
  })

  it('кнопка «Найти» применяет запрос, не дожидаясь паузы набора', async () => {
    page()
    fireEvent.change(searchInput(), { target: { value: 'anna' } })
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }))

    await waitFor(() => expect(lastQuery().q).toBe('anna'))
  })

  it('отправка формы (Enter) делает то же самое', async () => {
    page()
    fireEvent.change(searchInput(), { target: { value: '@anna' } })
    fireEvent.submit(searchInput().closest('form') as HTMLFormElement)

    await waitFor(() => expect(lastQuery().q).toBe('@anna'))
  })

  it('повторное нажатие «Найти» перезапрашивает сервер, а не молчит', async () => {
    page()
    fireEvent.change(searchInput(), { target: { value: 'anna' } })
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }))
    await waitFor(() => expect(lastQuery().q).toBe('anna'))
    const before = mocks.list.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Найти' }))
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(before))
    expect(lastQuery().q).toBe('anna')
  })

  it('один символ поиск не запускает — остаётся подсказка про два символа', async () => {
    page()
    await waitFor(() => expect(mocks.list).toHaveBeenCalled())
    mocks.list.mockClear()

    fireEvent.change(searchInput(), { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }))

    expect(screen.getByText(/Поиск идёт от двух символов/)).toBeInTheDocument()
    // Каталог уже показан целиком: перезапрашивать нечего, и запрос уходит
    // только когда символов станет два.
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
