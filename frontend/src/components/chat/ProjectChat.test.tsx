import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectChat } from './ProjectChat'
import { notifyChatChanged } from '../../lib/chatEvents'
import { useAuthStore } from '../../store/auth'

/**
 * Чат проекта (0.95.0).
 *
 * Проверяем то, ради чего он существует: сообщение уходит с ссылкой на кадр, ответ Нестора
 * появляется отдельным сообщением, а «бот выключен» — объяснение рядом, а не молчание.
 * Плюс ссылка: клик открывает кадр (страница переключит вкладку).
 */

const listChat = vi.fn()
const postChat = vi.fn()
const editChat = vi.fn()
const listEventRows = vi.fn()

vi.mock('../../api/chat', () => ({
  listChat: (...args: unknown[]) => listChat(...args),
  postChat: (...args: unknown[]) => postChat(...args),
  editChat: (...args: unknown[]) => editChat(...args),
}))

/** Текущий пользователь: «изменить» показывается только у своих сообщений. */
const mockCurrentUser = (id: string | null) => {
  useAuthStore.setState({
    user: id ? { id, email: 'me@example.com', display_name: 'Я', is_admin: false } : null,
  })
}

vi.mock('../../api/events', () => ({
  listEventRows: (...args: unknown[]) => listEventRows(...args),
}))

const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  project_id: 'p1',
  author_name: 'Аня',
  kind: 'user' as const,
  body: 'Как вам новая глава?',
  created_at: '2026-10-28T10:00:00Z',
  ...over,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

const base = { projectId: 'p1', visible: true }

describe('ProjectChat', () => {
  it('показывает сообщения с автором и ссылкой на кадр', async () => {
    listChat.mockResolvedValue({
      messages: [
        message(),
        message({ id: 'm2', author_name: 'Нестор', kind: 'bot', body: 'Сцена держит внимание.' }),
        message({ id: 'm3', event_id: 'f1', quote: 'Анна стоит на пороге' }),
      ],
      bot: { name: 'Нестор', available: true },
    })
    listEventRows.mockResolvedValue([{ id: 'f1', title: 'Пролог', parent_id: null, body: '', event_date: null }])

    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getAllByText('Как вам новая глава?').length).toBeGreaterThan(0))
    expect(screen.getByText('Нестор')).toBeTruthy()
    expect(screen.getByText('Сцена держит внимание.')).toBeTruthy()
    // Ссылка на кадр: в подписи — цитата, по которой открывается кадр.
    expect(screen.getByRole('button', { name: /Анна стоит на пороге/ })).toBeTruthy()
  })

  it('отправляет сообщение и показывает ответ Нестора', async () => {
    listChat.mockResolvedValue({ messages: [], bot: { name: 'Нестор', available: true } })
    listEventRows.mockResolvedValue([])
    postChat.mockResolvedValue({
      message: message({ id: 'm10', body: 'Нестор, что думаешь?' }),
      reply: message({ id: 'm11', kind: 'bot', author_name: 'Нестор', body: 'Думаю, стоит замедлить.' }),
    })
    render(<ProjectChat {...base} />)
    const input = await screen.findByLabelText('Сообщение в чат проекта')
    fireEvent.change(input, { target: { value: 'Нестор, что думаешь?' } })
    fireEvent.click(screen.getByRole('button', { name: 'спросить бота' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))

    await waitFor(() => expect(postChat).toHaveBeenCalled())
    const [, payload] = postChat.mock.calls[0]
    expect(payload).toMatchObject({ body: 'Нестор, что думаешь?', askBot: true })
    await waitFor(() => expect(screen.getByText('Думаю, стоит замедлить.')).toBeTruthy())
    // Поле очищено: следующий вопрос пишется с чистого листа.
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('бот выключен — кнопки нет, а присланная причина видна рядом', async () => {
    listChat.mockResolvedValue({ messages: [], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    postChat.mockResolvedValue({
      message: message({ id: 'm20' }),
      note: 'Нестор выключен — сообщение сохранено, ответа не будет',
    })
    render(<ProjectChat {...base} />)
    expect(screen.queryByRole('button', { name: 'спросить бота' })).toBeNull()
    const input = await screen.findByLabelText('Сообщение в чат проекта')
    fireEvent.change(input, { target: { value: 'Без бота' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(screen.getByText(/Нестор выключен/)).toBeTruthy())
  })

  it('сообщение с выбранным кадром уносит ссылку и цитату', async () => {
    listChat.mockResolvedValue({ messages: [], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([{ id: 'f1', title: 'Пролог', parent_id: null, body: '', event_date: null }])
    postChat.mockResolvedValue({ message: message({ id: 'm30' }) })
    render(<ProjectChat {...base} />)
    const frame = await screen.findByLabelText('Приложить кадр')
    await waitFor(() => expect((frame as HTMLSelectElement).options.length).toBe(2))
    fireEvent.change(frame, { target: { value: 'f1' } })
    fireEvent.change(screen.getByLabelText('Фраза из кадра'), { target: { value: 'Анна стоит' } })
    fireEvent.change(screen.getByLabelText('Сообщение в чат проекта'), { target: { value: 'Вот тут спорно' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(postChat).toHaveBeenCalled())
    expect(postChat.mock.calls[0][1]).toMatchObject({ eventId: 'f1', quote: 'Анна стоит' })
  })

  it('клик по ссылке открывает кадр', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm3', event_id: 'f1', quote: 'Анна стоит' })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    const onOpenFrame = vi.fn()
    render(<ProjectChat {...base} onOpenFrame={onOpenFrame} />)
    const link = await screen.findByRole('button', { name: /к кадру/ })
    fireEvent.click(link)
    expect(onOpenFrame).toHaveBeenCalledWith('f1')
  })

  it('сигнал из сокета догружает новое и не дублирует показанное (0.96.0)', async () => {
    listChat.mockResolvedValueOnce({
      messages: [message({ id: 'm1' })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getAllByText('Как вам новая глава?').length).toBe(1))

    // Сигнал «в чате есть новое» приходит по сокету документа; сервер при этом повторяет и
    // старое — дубликат появляться не должен.
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1' }), message({ id: 'm2', body: 'И ещё мысль.' })],
      bot: { name: 'Нестор', available: false },
    })
    notifyChatChanged('p1')
    await waitFor(() => expect(screen.getByText('И ещё мысль.')).toBeTruthy())
    expect(screen.getAllByText('Как вам новая глава?').length).toBe(1)
  })

  it('сигнал чужого проекта не трогает этот чат', async () => {
    listChat.mockResolvedValue({ messages: [message({ id: 'm1' })], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getAllByText('Как вам новая глава?').length).toBe(1))
    const callsBefore = listChat.mock.calls.length
    notifyChatChanged('другой-проект')
    await waitFor(() => expect(listChat.mock.calls.length).toBe(callsBefore))
  })

  it('ответ на сообщение: цитата в ленте и reply_to в запросе', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1' }), message({ id: 'm2', reply_to: 'm1', body: 'Отвечаю.' })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    postChat.mockResolvedValue({ message: message({ id: 'm5' }) })
    render(<ProjectChat {...base} />)
    // В ленте видно, на что отвечают.
    await waitFor(() => expect(screen.getByText(/→ Аня: Как вам новая глава\?/)).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'ответить' })[1])
    expect(screen.getByText(/ответ Аня:/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Сообщение в чат проекта'), { target: { value: 'И мой ответ.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(postChat).toHaveBeenCalled())
    expect(postChat.mock.calls[0][1]).toMatchObject({ body: 'И мой ответ.', replyTo: 'm2' })
  })

  it('своё сообщение можно изменить, чужое — нет (0.96.0)', async () => {
    const me = { id: 'm1', project_id: 'p1', author_id: 'u1', author_name: 'Я', kind: 'user' as const, body: 'Моё сообщение.', created_at: '2026-10-28T10:00:00Z' }
    const other = { ...message({ id: 'm2' }), author_id: 'u2' }
    listChat.mockResolvedValue({ messages: [me, other], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    mockCurrentUser('u1')
    editChat.mockResolvedValue({ ...me, body: 'Моё, исправленное.', edited_at: '2026-10-28T10:05:00Z' })
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getByText('Моё сообщение.')).toBeTruthy())
    // У чужого кнопки правки нет.
    expect(screen.queryByRole('button', { name: 'изменить' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'изменить' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'изменить' }))
    fireEvent.change(screen.getByLabelText('Изменить сообщение Я'), { target: { value: 'Моё, исправленное.' } })
    expect(screen.getByRole('button', { name: 'сохранить' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'сохранить' }))
    await waitFor(() => expect(editChat).toHaveBeenCalled())
    // Диагностика: какие аргументы пришли на самом деле.
    expect(editChat.mock.calls[0]).toEqual(['p1', 'm1', 'Моё, исправленное.'])
    await waitFor(() => expect(screen.getByText('Моё, исправленное.')).toBeTruthy())
    // Отметка «изменено» появляется у правленого сообщения.
    expect(screen.getByText('изменено')).toBeTruthy()
  })
})
