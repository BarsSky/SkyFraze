import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Y from 'yjs'
import { colorFor, initialsOf, type PeerState } from '../../collab/awareness'
import { yAddEvent } from '../../collab/yprovider'
import { EditorsPanel } from './EditorsPanel'

/**
 * Присутствие со стороны панели редакторов: что уходит соседям при открытии
 * события, при вводе и при уходе со страницы.
 *
 * Редактор события подменён: здесь проверяется панель (расписание вызовов
 * `onEditing` и отметки у строк), а markdown-it/katex/mermaid тянет за собой
 * настоящий EventEditor — те же лишние секунды на импорт, от которых защищается
 * соседний EditorsPanel.test.tsx.
 */
vi.mock('./EventEditor', () => ({
  EventEditor: ({ ymap, onChange, onTyping }: {
    ymap: Y.Map<unknown>
    onChange?: () => void
    onTyping?: () => void
  }) => (
    <input
      aria-label="Заголовок события"
      value={(ymap.get('title') as string | undefined) ?? ''}
      onChange={(e) => {
        ymap.set('title', e.target.value)
        onChange?.()
        onTyping?.()
      }}
    />
  ),
}))

const peer = (over: Partial<PeerState> = {}): PeerState => {
  const merged = {
    clientId: 'c1',
    userId: 'u1',
    name: 'Аня Ваар',
    eventId: null as string | null,
    typing: false,
    ...over,
  }
  return { ...merged, initials: initialsOf(merged.name), color: colorFor(merged.userId) }
}

interface ShowOptions {
  onEditing?: (eventId: string | null, typing?: boolean) => void
  /** Соседи фиксированные либо зависящие от id события (форма выбирается сама). */
  presence?: PeerState[] | ((chapterId: string) => PeerState[])
}

/** Одна глава: панель сама выбирает первое событие, и форма сразу открыта. */
function show(options: ShowOptions = {}) {
  const doc = new Y.Doc()
  const events = doc.getArray<Y.Map<unknown>>('events')
  const chapterId = yAddEvent(events, 'Глава 1').get('id') as string
  const presence = typeof options.presence === 'function' ? options.presence(chapterId) : options.presence
  const result = render(
    <EditorsPanel
      events={events}
      assets={[]}
      assetUrls={{}}
      onChanged={vi.fn()}
      onUpload={async () => null}
      onEditing={options.onEditing}
      presence={presence}
    />,
  )
  return { ...result, chapterId }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('EditorsPanel — присутствие', () => {
  it('на открытии события сообщает, что правлю его, но ещё не печатаю', () => {
    const onEditing = vi.fn()
    const { chapterId } = show({ onEditing })

    expect(onEditing).toHaveBeenCalledWith(chapterId, false)
    expect(onEditing).not.toHaveBeenCalledWith(chapterId, true)
  })

  it('ввод шлёт одно «печатаю» и гаснет через 1.5 с тишины', () => {
    const onEditing = vi.fn()
    const { chapterId } = show({ onEditing })
    onEditing.mockClear()

    const input = screen.getByLabelText('Заголовок события')
    fireEvent.change(input, { target: { value: 'Глава 1 (правка)' } })
    expect(onEditing).toHaveBeenCalledTimes(1)
    expect(onEditing).toHaveBeenCalledWith(chapterId, true)

    // Второе нажатие внутри паузы: серия ещё идёт, повторный кадр не нужен.
    fireEvent.change(input, { target: { value: 'Глава 1 (правка 2)' } })
    expect(onEditing).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(1600)
    })
    expect(onEditing).toHaveBeenCalledTimes(2)
    expect(onEditing).toHaveBeenLastCalledWith(chapterId, false)
  })

  it('размонтирование убирает меня из присутствия сразу', () => {
    const onEditing = vi.fn()
    const { unmount } = show({ onEditing })
    onEditing.mockClear()

    unmount()

    expect(onEditing).toHaveBeenCalledWith(null, false)
  })

  it('помечает строку инициалами того, кто её правит, и подписью «печатает…»', () => {
    show({
      presence: (chapterId) => [
        peer({ name: 'Аня Ваар', userId: 'u1', eventId: chapterId, typing: true }),
      ],
    })

    const marker = document.querySelector('[data-peer-editing="Аня Ваар"]')
    expect(marker).not.toBeNull()
    expect(marker?.textContent).toBe('АВ')
    expect(document.body.textContent).toContain('Аня Ваар печатает…')
  })

  it('чужая строка остаётся без отметок', () => {
    show({ presence: [peer({ eventId: 'другое-событие', typing: true })] })

    expect(document.querySelector('[data-peer-editing]')).toBeNull()
    expect(document.body.textContent).not.toContain('печатает…')
  })
})
