import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { describeApiError, type ApiErrorSubject } from '../lib/apiError'

interface Props {
  /** Ошибка как она пришла (ky HTTPError, TimeoutError, что угодно). */
  error: unknown
  /** Повторить загрузку — кнопка появится только для повторяемых ошибок. */
  onRetry?: () => void
  /** Дополнительные ссылки «куда можно пойти» (например, в ленту). */
  actions?: ReactNode
  /** Контекст для заголовка: «Лента», «История», «Админка». */
  what?: string
  /** О чём ошибка: у 404 для человека и для истории разные подсказки. */
  subject?: ApiErrorSubject
}

/**
 * Баннер ошибки с выходами.
 *
 * Правило: пользователь никогда не должен видеть сырой текст вроде
 * «TimeoutError: Request timed out: GET http://…» без кнопки, что делать дальше.
 * Поэтому баннер всегда содержит (а) что случилось по-человечески, (б) подсказку,
 * (в) «Повторить» для временных сбоев и (г) минимум одну доступную ссылку.
 */
export function ErrorBanner({ error, onRetry, actions, what, subject }: Props) {
  const info = describeApiError(error, subject)
  return (
    <div className={`banner banner--${info.kind}`} role="alert" data-error-kind={info.kind}>
      <div className="banner__body">
        <b className="banner__title">
          {what ? `${what}: ` : ''}
          {info.title}
        </b>
        <span className="banner__hint">{info.hint}</span>
      </div>
      <div className="banner__actions">
        {info.retryable && onRetry && (
          <button type="button" onClick={onRetry}>
            Повторить
          </button>
        )}
        {actions ?? (
          <Link className="banner__link" to="/feed">
            ← В ленту
          </Link>
        )}
      </div>
    </div>
  )
}
