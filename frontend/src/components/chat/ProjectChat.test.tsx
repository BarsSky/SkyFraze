import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectChat } from './ProjectChat'
import { notifyChatChanged } from '../../lib/chatEvents'
import { useAuthStore } from '../../store/auth'
import { setLang } from '../../store/lang'

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
const toggleChatReaction = vi.fn()

const markChatSeen = vi.fn().mockResolvedValue(undefined)

vi.mock('../../api/chat', () => ({
  listChat: (...args: unknown[]) => listChat(...args),
  postChat: (...args: unknown[]) => postChat(...args),
  editChat: (...args: unknown[]) => editChat(...args),
  toggleChatReaction: (...args: unknown[]) => toggleChatReaction(...args),
  markChatSeen: (...args: unknown[]) => markChatSeen(...args),
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
  reactions: { agree: 0, todo: 0, question: 0, mine: [] },
  ...over,
})

afterEach(() => {
  setLang('ru')
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

  it('открытый чат отмечается прочитанным на сервере (0.97.0)', async () => {
    listChat.mockResolvedValue({ messages: [message({ id: 'm1' })], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(markChatSeen).toHaveBeenCalledWith('p1'))
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

  /**
   * Отметки на сообщении (0.98.0): «согласен», «сделать», «вопрос».
   *
   * Проверяем ровно то, что человек видит и нажимает: все три плашки на месте даже при нулях, у
   * своей отметки видно нажатое состояние и число, нажатие уходит на сервер с видом отметки, а
   * ответ сервера перерисовывает счётчики без перечитывания ленты.
   */
  it('отметки: три плашки, счётчик и нажатое состояние (0.98.0)', async () => {
    listChat.mockResolvedValue({
      messages: [
        message({
          id: 'm1',
          reactions: { agree: 2, todo: 1, question: 0, mine: ['todo'] },
        }),
      ],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)

    const row = await screen.findByLabelText('надо сделать: 1')
    expect(row.getAttribute('aria-pressed')).toBe('true')
    // У нулевой отметки числа нет, но подпись есть — иначе не видно, что нажимать можно.
    const question = screen.getByLabelText('вопрос')
    expect(question.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('согласен: 2').textContent).toContain('2')
  })

  it('отметку ставят и снимают одним нажатием, ответ сервера перерисовывает счётчик (0.98.0)', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1', reactions: { agree: 0, todo: 0, question: 0, mine: [] } })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    toggleChatReaction.mockResolvedValue({ agree: 1, todo: 0, question: 0, mine: ['agree'] })
    render(<ProjectChat {...base} />)

    fireEvent.click(await screen.findByLabelText('согласен'))
    await waitFor(() => expect(toggleChatReaction).toHaveBeenCalledWith('p1', 'm1', 'agree'))
    // Счётчик и нажатое состояние пришли из ответа — без второго запроса ленты.
    expect(await screen.findByLabelText('согласен: 1')).toBeTruthy()
    expect(screen.getByLabelText('согласен: 1').getAttribute('aria-pressed')).toBe('true')
    expect(listChat).toHaveBeenCalledTimes(1)
  })

  it('отметка чужого человека видна как число, но не как нажатая (0.98.0)', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1', reactions: { agree: 3, todo: 0, question: 1, mine: [] } })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    const agree = await screen.findByLabelText('согласен: 3')
    expect(agree.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('вопрос: 1').getAttribute('aria-pressed')).toBe('false')
  })

  it('отметка не поставилась — причина видна рядом, лента не портится (0.98.0)', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1', reactions: { agree: 0, todo: 0, question: 0, mine: [] } })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    toggleChatReaction.mockRejectedValue(new Error('нужны права участника'))
    render(<ProjectChat {...base} />)
    fireEvent.click(await screen.findByLabelText('вопрос'))
    await waitFor(() => expect(screen.getByText(/нужны права участника/)).toBeTruthy())
    // Счётчик остался нулевым: неудачное нажатие не делает вид, что отметка встала.
    expect(screen.getByLabelText('вопрос').getAttribute('aria-pressed')).toBe('false')
  })

  it('сигнал из сокета перечитывает ленту: чужая отметка появляется без перезагрузки (0.98.0)', async () => {
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1', reactions: { agree: 0, todo: 0, question: 0, mine: [] } })],
      bot: { name: 'Нестор', available: false },
    })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    await screen.findByLabelText('согласен')

    // Кто-то поставил отметку: сервер присылает сигнал, лента перечитывается целиком (не «после
    // последнего» — отметка меняет УЖЕ показанное сообщение).
    listChat.mockResolvedValue({
      messages: [message({ id: 'm1', reactions: { agree: 1, todo: 0, question: 0, mine: [] } })],
      bot: { name: 'Нестор', available: false },
    })
    notifyChatChanged('p1')
    await waitFor(() => expect(screen.getByLabelText('согласен: 1')).toBeTruthy())
  })

  /**
   * История «показать прежние» (0.99.2).
   *
   * До этого окно открывалось последними ста сообщениями, и в живом проекте начало разговора было
   * недостижимо вовсе. Кнопка появляется только если сервер отдал ПОЛНУЮ страницу: неполная значит
   * «это всё», и кнопка, которая ничего не находит, хуже её отсутствия.
   */
  const page = (count: number, prefix: string, startAt = 1) =>
    Array.from({ length: count }, (_, index) => message({ id: `${prefix}${startAt + index}` }))

  it('кнопка «показать прежние» есть только при полной странице (0.99.2)', async () => {
    listChat.mockResolvedValue({ messages: page(100, 'm'), bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    expect(await screen.findByText('показать прежние')).toBeTruthy()
    cleanup()

    // Неполная страница — история кончилась, кнопки нет.
    listChat.mockResolvedValue({ messages: page(3, 'm'), bot: { name: 'Нестор', available: false } })
    render(<ProjectChat {...base} />)
    await waitFor(() => expect(screen.getAllByText('Как вам новая глава?').length).toBe(3))
    expect(screen.queryByText('показать прежние')).toBeNull()
  })

  it('нажатие подгружает прежние сообщения СВЕРХУ и убирает кнопку (0.99.2)', async () => {
    listChat.mockResolvedValueOnce({ messages: page(100, 'm', 100), bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    const button = await screen.findByText('показать прежние')

    // Первая страница — свежие (m100..m199), вторая (назад) — 5 более старых: m95..m99.
    listChat.mockResolvedValueOnce({
      messages: Array.from({ length: 5 }, (_, index) => message({ id: `m${95 + index}`, body: `старое ${95 + index}` })),
      bot: { name: 'Нестор', available: false },
    })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByText('старое 95')).toBeTruthy())
    // Запрос ушёл именно «до первого показанного», а не «после последнего».
    expect(listChat.mock.calls.at(-1)?.[1]).toEqual({ before: 'm100' })
    // Неполная страница — кнопка исчезла: раньше этого уже нет.
    expect(screen.queryByText('показать прежние')).toBeNull()
  })

  it('пустая страница прежних тоже убирает кнопку, а не крутит её вечно (0.99.2)', async () => {
    listChat.mockResolvedValueOnce({ messages: page(100, 'm'), bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    render(<ProjectChat {...base} />)
    const button = await screen.findByText('показать прежние')
    listChat.mockResolvedValueOnce({ messages: [], bot: { name: 'Нестор', available: false } })
    fireEvent.click(button)
    await waitFor(() => expect(screen.queryByText('показать прежние')).toBeNull())
  })

  /**
   * 0.125.0: подписи чата — из словаря, включая отметки («надо сделать» → «to do») и
   * подсказки бота. Тексты сообщений и имена участников остаются данными.
   */
  it('на английском подписи чата переведены', async () => {
    setLang('en')
    render(<ProjectChat {...base} />)
    expect(await screen.findByText('Project chat')).toBeTruthy()
    expect(screen.getByText('seen by every member')).toBeTruthy()
    expect(screen.getByLabelText('Message to the project chat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    // Отметки: короткая подпись и доступное имя из словаря.
    expect(screen.getAllByRole('button', { name: /^agree$/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /^to do$/ }).length).toBeGreaterThan(0)
  })

  /**
   * 0.132.0: цитата из показа проекта. Выделенный фрагмент приходит в поле готовой ссылкой на
   * кадр — но НЕ отправляется: человек дописывает мысль сам, а автоотправка была бы решением
   * за него.
   */
  it('цитата из показа подставляется в поле со ссылкой на кадр и не отправляется', async () => {
    listChat.mockResolvedValue({ messages: [], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([{ id: 'f1', title: 'Пролог', parent_id: null, body: '', event_date: null }])
    render(
      <ProjectChat
        {...base}
        prefill={{ tab: 'chat', nonce: 1, frameId: 'f1', frameTitle: 'Пролог', quote: 'Аня стоит на пороге' }}
      />,
    )

    const input = (await screen.findByLabelText('Сообщение в чат проекта')) as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toContain('Аня стоит на пороге'))
    expect(input.value).toContain('Пролог')
    // Ничего не ушло: поле заполнено, отправка — за человеком.
    expect(postChat).not.toHaveBeenCalled()
    // Ссылка на кадр приложена к будущему сообщению, и фраза уже стоит.
    await waitFor(() =>
      expect((screen.getByLabelText('Приложить кадр') as HTMLSelectElement).value).toBe('f1'),
    )
    expect((screen.getByLabelText('Фраза из кадра') as HTMLInputElement).value).toBe(
      'Аня стоит на пороге',
    )
  })

  it('дописанное человеком не затирается, пока не выделили другой фрагмент', async () => {
    listChat.mockResolvedValue({ messages: [], bot: { name: 'Нестор', available: false } })
    listEventRows.mockResolvedValue([])
    const prefill = { tab: 'chat' as const, nonce: 1, frameId: 'f1', frameTitle: 'Пролог', quote: 'Аня' }
    const view = render(<ProjectChat {...base} prefill={prefill} />)
    const input = (await screen.findByLabelText('Сообщение в чат проекта')) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'моя мысль' } })

    // Перерисовка по другой причине (новое сообщение в ленте) — текст остаётся.
    view.rerender(<ProjectChat {...base} prefill={prefill} />)
    expect((screen.getByLabelText('Сообщение в чат проекта') as HTMLTextAreaElement).value).toBe('моя мысль')

    // Новое выделение — новый nonce, поле заменяется.
    view.rerender(<ProjectChat {...base} prefill={{ ...prefill, nonce: 2, quote: 'дом на холме' }} />)
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Сообщение в чат проекта') as HTMLTextAreaElement).value,
      ).toContain('дом на холме'),
    )
  })
})
