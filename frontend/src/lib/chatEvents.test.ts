import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_CHANGED_EVENT, notifyChatChanged, onChatChanged } from './chatEvents'

/**
 * Событие «есть новое в чате» (0.96.0).
 *
 * Проверяем главное свойство: подписка одного проекта не срабатывает на чужой проект. На странице
 * открыт один проект, но событие идёт через общее окно — перепутать проекты значило бы дёргать
 * чужой чат (и лишний запрос, и мигание).
 */

afterEach(() => {
  // Подписки снимаем сами в тестах; здесь — чистое окно для следующего.
  vi.restoreAllMocks()
})

describe('chatEvents', () => {
  it('сообщает о новом в своём проекте и молчит о чужом', () => {
    const own = vi.fn()
    const foreign = vi.fn()
    const offOwn = onChatChanged('p1', own)
    const offForeign = onChatChanged('p2', foreign)

    notifyChatChanged('p1')
    expect(own).toHaveBeenCalledTimes(1)
    expect(foreign).not.toHaveBeenCalled()

    offOwn()
    notifyChatChanged('p1')
    expect(own).toHaveBeenCalledTimes(1)
    offForeign()
  })

  it('событие несёт идентификатор проекта', () => {
    let detail: unknown = null
    const handler = (event: Event) => {
      detail = (event as CustomEvent).detail
    }
    window.addEventListener(CHAT_CHANGED_EVENT, handler)
    notifyChatChanged('p9')
    window.removeEventListener(CHAT_CHANGED_EVENT, handler)
    expect(detail).toEqual({ projectId: 'p9' })
  })

  it('отписка возвращает чистое состояние', () => {
    const listener = vi.fn()
    const off = onChatChanged('p1', listener)
    off()
    notifyChatChanged('p1')
    expect(listener).not.toHaveBeenCalled()
  })
})
