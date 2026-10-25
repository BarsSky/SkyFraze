import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FrameComments } from './FrameComments'

/**
 * Обсуждение кадра.
 *
 * Проверяем то, что человек видит и трогает: список замечаний приезжает при выборе кадра,
 * своё можно удалить (чужое — нельзя), отправка добавляет комментарий и сбрасывает поле,
 * а читателю форма не показывается вовсе — иначе он написал бы замечание, которое сервер
 * отклонит.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../api/comments', () => ({
  listComments: mocks.list,
  createComment: mocks.create,
  deleteComment: mocks.remove,
}))

const ME = { id: 'u1', email: 'me@example.com', display_name: 'Я', is_admin: false }

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) => selector({ user: ME }),
}))

const OWN = {
  id: 'c1',
  eventId: 'e1',
  userId: 'u1',
  authorName: 'Я',
  body: 'Тут герой не мог знать про маяк.',
  createdAt: '2026-10-25T10:00:00Z',
}
const OTHER = {
  id: 'c2',
  eventId: 'e1',
  userId: 'u2',
  authorName: 'Соавтор',
  body: 'Согласен, перепишу.',
  createdAt: '2026-10-25T11:00:00Z',
}

function show(canEdit = true, onCountChange = vi.fn()) {
  render(
    <FrameComments projectId="p1" eventId="e1" canEdit={canEdit} onCountChange={onCountChange} />,
  )
  return onCountChange
}

beforeEach(() => {
  mocks.list.mockResolvedValue([OWN, OTHER])
  mocks.create.mockResolvedValue({
    ...OWN,
    id: 'c3',
    body: 'Новое замечание.',
    createdAt: '2026-10-25T12:00:00Z',
  })
  mocks.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('FrameComments', () => {
  it('показывает обсуждение кадра и его число', async () => {
    show()
    expect(await screen.findByText('Тут герой не мог знать про маяк.')).toBeTruthy()
    expect(screen.getByText('Согласен, перепишу.')).toBeTruthy()
    expect(screen.getByText('Соавтор')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy())
  })

  it('удалить можно только свой комментарий', async () => {
    const onCount = show()
    await screen.findByText('Согласен, перепишу.')
    const buttons = screen.getAllByRole('button', { name: /Удалить комментарий/ })
    // Одна кнопка удаления — у своего комментария, не у чужого.
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'c1'))
    await waitFor(() => expect(screen.queryByText('Тут герой не мог знать про маяк.')).toBeNull())
    expect(onCount).toHaveBeenLastCalledWith('e1', 1)
  })

  it('отправка добавляет комментарий и очищает поле', async () => {
    const onCount = show()
    await screen.findByText('Согласен, перепишу.')
    const input = screen.getByLabelText('Новый комментарий') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Новое замечание.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Написать' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p1', 'e1', 'Новое замечание.'))
    expect(await screen.findByText('Новое замечание.')).toBeTruthy()
    // Поле сброшено: иначе второе нажатие отправило бы то же самое ещё раз.
    await waitFor(() => expect((screen.getByLabelText('Новый комментарий') as HTMLTextAreaElement).value).toBe(''))
    expect(onCount).toHaveBeenLastCalledWith('e1', 3)
  })

  it('пустой комментарий отправить нельзя', async () => {
    show()
    await screen.findByText('Согласен, перепишу.')
    const button = screen.getByRole('button', { name: 'Написать' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Новый комментарий'), { target: { value: '   ' } })
    expect(button.disabled).toBe(true)
  })

  it('читателю форма не показывается', async () => {
    show(false)
    await screen.findByText('Согласен, перепишу.')
    expect(screen.queryByLabelText('Новый комментарий')).toBeNull()
    expect(screen.getByText(/Читать обсуждение можно/)).toBeTruthy()
  })

  it('ошибка отправки объясняется словами и не теряет текст', async () => {
    mocks.create.mockRejectedValue(new Error('нет прав на изменение этого проекта'))
    show()
    await screen.findByText('Согласен, перепишу.')
    fireEvent.change(screen.getByLabelText('Новый комментарий'), {
      target: { value: 'Замечание, которое не уйдёт.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Написать' }))
    expect(await screen.findByText(/Нет прав на изменение|Не удалось отправить/)).toBeTruthy()
    // Текст остался в поле: человек не должен набирать замечание заново.
    expect((screen.getByLabelText('Новый комментарий') as HTMLTextAreaElement).value).toBe(
      'Замечание, которое не уйдёт.',
    )
  })
})
