/**
 * «В проекте появилось сообщение чата» — событие в окне браузера (0.96.0).
 *
 * Канал доставки — уже открытый сокет документа: сервер рассылает служебный кадр `sfc1:` в комнату
 * проекта, клиент сокета превращает его в это событие, а чат по нему сразу спрашивает «что нового».
 * Почему событие, а не проп через полстраницы: сокет живёт на странице проекта, чат — глубоко в
 * окне помощника, и тянуть колбэк через три компонента значило бы связать их ради одной строки.
 *
 * Содержимого в событии нет намеренно: сообщение хранится в одном месте (база), и второй копии
 * в канале доставки не нужно — иначе они рано или поздно разойдутся.
 */
export const CHAT_CHANGED_EVENT = 'skyfraze:chat-changed'

/** Сообщить открытым вкладкам проекта, что в чате есть новое. */
export function notifyChatChanged(projectId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CHAT_CHANGED_EVENT, { detail: { projectId } }))
}

/**
 * Подписка на «есть новое» для одного проекта. Возвращает отписку.
 *
 * Фильтр по проекту обязателен: на странице может быть открыт только один проект, но событие
 * приходит из общего окна, и перепутать проекты значило бы дёргать чужой чат.
 */
export function onChatChanged(projectId: string, listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ projectId?: string }>).detail
    if (!detail?.projectId || detail.projectId === projectId) listener()
  }
  window.addEventListener(CHAT_CHANGED_EVENT, handler)
  return () => window.removeEventListener(CHAT_CHANGED_EVENT, handler)
}
