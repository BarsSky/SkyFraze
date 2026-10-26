import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FrameComments } from './FrameComments'
import type { FrameComment } from '../../api/comments'

/**
 * Обсуждение кадра.
 *
 * Проверяем то, что человек видит и трогает: список замечаний приезжает при выборе кадра,
 * ответы стоят под своим замечанием, отправка сбрасывает поле, удалённое замечание остаётся
 * на месте «удалённым» (иначе вместе с ним исчезли бы чужие ответы), а читателю форма не
 * показывается вовсе — иначе он написал бы замечание, которое сервер отклонит.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  seen: vi.fn(),
  members: vi.fn(),
  react: vi.fn(),
}))

vi.mock('../../api/comments', () => ({
  listComments: mocks.list,
  createComment: mocks.create,
  deleteComment: mocks.remove,
  markCommentsSeen: mocks.seen,
  setCommentReaction: mocks.react,
}))

vi.mock('../../api/teams', () => ({
  listMembers: mocks.members,
}))

const ME = { id: 'u1', email: 'me@example.com', display_name: 'Я', is_admin: false }

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) => selector({ user: ME }),
}))

const comment = (over: Partial<FrameComment> = {}): FrameComment => ({
  id: 'c1',
  eventId: 'e1',
  userId: 'u1',
  authorName: 'Я',
  body: 'Тут герой не мог знать про маяк.',
  createdAt: '2026-10-25T10:00:00Z',
  parentId: null,
  deleted: false,
  reactions: { agree: 0, done: 0, mine: [] },
  ...over,
})

const OWN = comment()
const OTHER = comment({
  id: 'c2',
  userId: 'u2',
  authorName: 'Соавтор',
  body: 'Согласен, перепишу.',
  createdAt: '2026-10-25T11:00:00Z',
})

function show(canEdit = true, onCountChange = vi.fn()) {
  render(
    <FrameComments projectId="p1" eventId="e1" canEdit={canEdit} onCountChange={onCountChange} />,
  )
  return onCountChange
}

beforeEach(() => {
  mocks.list.mockResolvedValue([OWN, OTHER])
  mocks.seen.mockResolvedValue(undefined)
  mocks.create.mockResolvedValue(comment({ id: 'c3', body: 'Новое замечание.', createdAt: '2026-10-25T12:00:00Z' }))
  mocks.remove.mockResolvedValue(undefined)
  mocks.members.mockResolvedValue([
    { project_id: 'p1', user_id: 'u1', role: 'owner', added_at: '', username: 'owner', display_name: 'Я' },
    { project_id: 'p1', user_id: 'u2', role: 'editor', added_at: '', username: 'editor', display_name: 'Соавтор' },
  ])
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
    // Показ обсуждения = «прочитано»: отметка уходит на сервер сразу, иначе счётчик
    // новых висел бы до перезагрузки страницы.
    await waitFor(() => expect(mocks.seen).toHaveBeenCalledWith('p1', 'e1'))
  })

  it('удалённое замечание остаётся строкой «Комментарий удалён», а ответы на него — живыми', async () => {
    const reply = comment({ id: 'r1', userId: 'u2', authorName: 'Соавтор', parentId: 'c1', body: 'Отвечаю.' })
    mocks.list.mockResolvedValue([{ ...OWN, deleted: true, body: '' }, reply])
    const onCount = show()

    expect(await screen.findByText('Комментарий удалён')).toBeTruthy()
    expect(screen.getByText('Отвечаю.')).toBeTruthy()
    // Счётчик зовёт к живому разговору: удалённое не считается.
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('e1', 1))
    expect(screen.getByText('1')).toBeTruthy()
  })

  it('удалить можно только свой комментарий', async () => {
    mocks.list
      .mockResolvedValueOnce([OWN, OTHER])
      .mockResolvedValue([{ ...OWN, deleted: true, body: '' }, OTHER])
    const onCount = show()
    await screen.findByText('Согласен, перепишу.')
    const buttons = screen.getAllByRole('button', { name: /Удалить комментарий/ })
    // Одна кнопка удаления — у своего комментария, не у чужого.
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'c1'))
    // Строка не исчезла: она стала «удалённой» — на ней могут висеть чужие ответы.
    expect(await screen.findByText('Комментарий удалён')).toBeTruthy()
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('e1', 1))
  })

  it('ответы стоят под своим замечанием', async () => {
    const reply = comment({ id: 'r1', userId: 'u2', authorName: 'Соавтор', parentId: 'c1', body: 'Отвечаю.' })
    mocks.list.mockResolvedValue([OWN, reply])
    show()
    await screen.findByText('Отвечаю.')
    const replyRow = document.querySelector('[data-frame-comment-id="r1"]')
    expect(replyRow?.getAttribute('data-frame-comment-reply')).toBe('1')
    // Ответ внутри ветки корня, а не отдельной строкой верхнего уровня.
    const thread = document.querySelector('[data-frame-thread="c1"]')
    expect(thread?.querySelector('[data-frame-comment-id="r1"]')).toBeTruthy()
  })

  it('ответ отправляется с родителем и появляется в ветке', async () => {
    mocks.create.mockResolvedValue(
      comment({ id: 'r2', userId: 'u1', parentId: 'c1', body: 'Мой ответ.', createdAt: '2026-10-25T13:00:00Z' }),
    )
    const onCount = show()
    await screen.findByText('Тут герой не мог знать про маяк.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Ответить' })[0])
    const field = screen.getByLabelText('Ответ на замечание') as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Мой ответ.' } })
    // Кнопка «Ответить» есть у каждого замечания, поэтому отправляем из формы этого корня.
    const form = document.querySelector('[data-frame-reply-form="c1"]') as HTMLElement
    expect(form).toBeTruthy()
    fireEvent.click(form.querySelector('button') as HTMLButtonElement)

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p1', 'e1', 'Мой ответ.', 'c1'))
    expect(await screen.findByText('Мой ответ.')).toBeTruthy()
    expect(document.querySelector('[data-frame-comment-id="r2"]')?.getAttribute('data-frame-comment-reply')).toBe('1')
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith('e1', 3))
    // Поле ответа закрылось: второй ответ на то же замечание — новое нажатие.
    expect(screen.queryByLabelText('Ответ на замечание')).toBeNull()
  })

  it('на удалённое замечание ответить нельзя — и кнопки нет', async () => {
    mocks.list.mockResolvedValue([{ ...OWN, deleted: true, body: '' }])
    show()
    await screen.findByText('Комментарий удалён')
    expect(screen.queryByRole('button', { name: 'Ответить' })).toBeNull()
  })

  it('ответ без родителя в списке не теряется', async () => {
    // Список обрезан лимитом: корня в нём нет, а ответ пришёл.
    mocks.list.mockResolvedValue([comment({ id: 'r9', parentId: 'нет-такого', body: 'Висящий ответ.' })])
    show()
    expect(await screen.findByText('Висящий ответ.')).toBeTruthy()
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
    // Кнопки «Ответить» у читателя тоже нет: писать он не может.
    expect(screen.queryByRole('button', { name: 'Ответить' })).toBeNull()
    expect(screen.getByText(/Читать обсуждение можно/)).toBeTruthy()
  })

  it('ошибка отправки объясняется словами и не теряет текст', async () => {    mocks.create.mockRejectedValue(new Error('нет прав на изменение этого проекта'))
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

  it('упоминание подсвечивается в тексте комментария', async () => {
    mocks.list.mockResolvedValue([comment({ body: 'Смотри @editor, тут дыра' })])
    show()
    await screen.findByText(/Смотри/)
    // Ник — отдельный элемент (подсветка), а не часть строки: по нему проверяется и цвет,
    // и то, что разбор совпал с серверным.
    expect(document.querySelector('[data-frame-mention="editor"]')).toBeTruthy()
  })

  it('при наборе @ предлагает участников и вставляет ник целиком', async () => {
    const onCount = show()
    const field = (await screen.findByLabelText('Новый комментарий')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'Смотри @ed', selectionStart: 10 } })

    const menu = document.querySelector('[data-frame-mention-menu]')
    expect(menu).toBeTruthy()
    // В подсказке — только подходящий участник: ник живёт отдельно от имени.
    expect(menu?.textContent).toContain('@editor')
    expect(menu?.textContent).not.toContain('@owner')

    fireEvent.click(menu?.querySelector('button') as HTMLButtonElement)
    await waitFor(() => expect((screen.getByLabelText('Новый комментарий') as HTMLTextAreaElement).value).toBe('Смотри @editor '))
    // Подсказка закрылась: набранный ник заменён, дальше пишется текст.
    expect(document.querySelector('[data-frame-mention-menu]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Написать' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('p1', 'e1', 'Смотри @editor'))
    expect(onCount).toHaveBeenCalled()
  })

  it('без участников с ником подсказка не открывается, текст пишется как есть', async () => {
    mocks.members.mockResolvedValue([])
    show()
    const field = (await screen.findByLabelText('Новый комментарий')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '@ed', selectionStart: 3 } })
    expect(document.querySelector('[data-frame-mention-menu]')).toBeNull()
    expect(field.value).toBe('@ed')
  })

  it('реакция ставится и снимается, счётчик берётся с сервера', async () => {
    mocks.list.mockResolvedValue([comment({ reactions: { agree: 2, done: 0, mine: [] } })])
    mocks.react.mockResolvedValue({ agree: 3, done: 0, mine: ['agree'] })
    show()
    await screen.findByText('Тут герой не мог знать про маяк.')

    const agree = document.querySelector('[data-frame-reaction="agree:2"]') as HTMLButtonElement
    expect(agree).toBeTruthy()
    expect(agree.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(agree)

    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith('p1', 'c1', 'agree', true))
    // Счётчик и «моё» пришли с сервера: интерфейс не пересчитывает их сам.
    const updated = document.querySelector('[data-frame-reaction="agree:3"]') as HTMLButtonElement
    expect(updated).toBeTruthy()
    expect(updated.getAttribute('aria-pressed')).toBe('true')
  })

  it('повторное нажатие снимает реакцию', async () => {
    mocks.list.mockResolvedValue([comment({ reactions: { agree: 1, done: 0, mine: ['agree'] } })])
    mocks.react.mockResolvedValue({ agree: 0, done: 0, mine: [] })
    show()
    await screen.findByText('Тут герой не мог знать про маяк.')

    const agree = document.querySelector('[data-frame-reaction="agree:1"]') as HTMLButtonElement
    fireEvent.click(agree)
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith('p1', 'c1', 'agree', false))
    expect(document.querySelector('[data-frame-reaction="agree:0"]')).toBeTruthy()
  })

  it('читателю реакции не нажимаются: реакция — след в проекте', async () => {
    mocks.list.mockResolvedValue([comment({ reactions: { agree: 1, done: 0, mine: [] } })])
    show(false)
    await screen.findByText('Тут герой не мог знать про маяк.')
    const agree = document.querySelector('[data-frame-reaction="agree:1"]') as HTMLButtonElement
    expect(agree.disabled).toBe(true)
  })

  it('удалённое замечание реакций не показывает', async () => {
    mocks.list.mockResolvedValue([comment({ deleted: true, body: '', reactions: { agree: 1, done: 0, mine: [] } })])
    show()
    await screen.findByText('Комментарий удалён')
    expect(document.querySelector('[data-frame-reactions]')).toBeNull()
  })
})
