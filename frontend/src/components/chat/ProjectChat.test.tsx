import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectChat } from './ProjectChat'

/**
 * Чат проекта (0.95.0).
 *
 * Проверяем то, ради чего он существует: сообщение уходит с ссылкой на кадр, ответ Нестора
 * появляется отдельным сообщением, а «бот выключен» — объяснение рядом, а не молчание.
 * Плюс ссылка: клик открывает кадр (страница переключит вкладку).
 */

const listChat = vi.fn()
const postChat = vi.fn()
const listEventRows = vi.fn()

vi.mock('../../api/chat', () => ({
  listChat: (...args: unknown[]) => listChat(...args),
  postChat: (...args: unknown[]) => postChat(...args),
}))

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

  it('опрос догружает новое и не дублирует уже показанное', async () => {
    listChat.mockResolvedValueOnce({
      messages: [message({ id: 'm1' })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getAllByText('Как вам новая глава?').length).toBe(1))

    // Второй опрос: сервер повторяет старое и отдаёт новое — дубликат не должен появиться.
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1' }), message({ id: 'm2', body: 'И ещё мысль.' })],
      bot: { name: 'Нестор', available: false },
    })
    await waitFor(() => expect(screen.getByText('И ещё мысль.')).toBeTruthy(), { timeout: 6000 })
    expect(screen.getAllByText('Как вам новая глава?').length).toBe(1)
  })
})
