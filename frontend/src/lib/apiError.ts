/**
 * Человеческое описание ошибки API.
 *
 * Сырой текст вроде «TimeoutError: Request timed out: GET http://…» ничего не
 * говорит пользователю: он не знает, что делать. Здесь ошибка превращается в
 * заголовок, пояснение и признак «есть смысл повторить».
 */

export type ApiErrorKind = 'offline' | 'timeout' | 'server' | 'auth' | 'forbidden' | 'notFound' | 'conflict' | 'unknown'

export interface ApiErrorInfo {
  kind: ApiErrorKind
  title: string
  hint: string
  /** Стоит ли предлагать «Повторить»: сеть и 5xx — да, 4xx — нет. */
  retryable: boolean
  status?: number
}

interface ErrLike {
  name?: string
  message?: string
  response?: { status?: number }
  cause?: unknown
}

export function describeApiError(e: unknown): ApiErrorInfo {
  const err = (e ?? {}) as ErrLike
  const status = err.response?.status
  const name = err.name ?? ''
  const message = err.message ?? ''

  if (status === 404) {
    return { kind: 'notFound', title: 'Страница не найдена', hint: 'Возможно, историю сняли с публикации или ссылка устарела.', retryable: false, status }
  }
  if (status === 401) {
    return { kind: 'auth', title: 'Нужно войти', hint: 'Сессия истекла — войдите заново, чтобы продолжить.', retryable: false, status }
  }
  if (status === 403) {
    return { kind: 'forbidden', title: 'Нет доступа', hint: 'У вашей роли нет прав на это действие.', retryable: false, status }
  }
  if (status === 409) {
    return { kind: 'conflict', title: 'Данные уже изменились', hint: 'Обновите страницу и повторите действие.', retryable: true, status }
  }
  if (typeof status === 'number' && status >= 500) {
    return { kind: 'server', title: 'Сервер не смог обработать запрос', hint: 'Это временная ошибка на сервере — попробуйте ещё раз через несколько секунд.', retryable: true, status }
  }
  if (name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return { kind: 'timeout', title: 'Сервер не ответил вовремя', hint: 'Связь могла прерваться (например, во время обновления сервера). Попробуйте ещё раз.', retryable: true }
  }
  if (name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message)) {
    return { kind: 'offline', title: 'Нет связи с сервером', hint: 'Проверьте подключение и попробуйте ещё раз.', retryable: true }
  }
  return { kind: 'unknown', title: 'Не удалось загрузить данные', hint: message || 'Неизвестная ошибка.', retryable: true, status }
}
