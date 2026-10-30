import { useCallback, useEffect, useState } from 'react'
import { tStatic, useT } from '../../i18n'
import { listLogins, type LoginAttempt } from '../../api/auth'
import { describeBrowser } from '../../lib/agent'

/**
 * Журнал входов (сервер: миграция 0029, ручка `GET /api/auth/logins`).
 *
 * Зачем отдельно от «активных сеансов»: сеансы отвечают на «где я вошёл сейчас», а журнал — на
 * «когда я входил» и «кто пробовал войти в мой аккаунт». Второе и есть ценность: неудачная
 * попытка — единственный след, который оставляет человек, подбирающий чужой пароль.
 *
 * Показываем последние 20 и говорим вслух, сколько журнал живёт: иначе список выглядит как
 * «всё, что было», и человек делает неверные выводы из пустоты.
 */

export function LoginHistory() {
  const t = useT()
  const [attempts, setAttempts] = useState<LoginAttempt[]>([])
  const [retentionDays, setRetentionDays] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await listLogins()
      setAttempts(result.attempts)
      setRetentionDays(result.retentionDays)
    } catch {
      // Профиль не должен ломаться из-за журнала: остальные настройки входа важнее.
      setAttempts([])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!loaded) return null

  return (
    <div className="logins" data-logins>
      <h4 className="twofa__subhead">{t('lh.title')}</h4>
      {attempts.length === 0 ? (
        <p className="muted" data-logins-empty>
          {t('lh.empty')}
        </p>
      ) : (
        <ul className="logins__list" data-logins-list>
          {attempts.map((attempt) => {
            const failed = attempt.outcome !== 'ok'
            return (
              <li
                key={attempt.id}
                className={failed ? 'logins__item logins__item--failed' : 'logins__item'}
                data-login-outcome={attempt.outcome}
              >
                <span className="logins__what">{describeLoginAttempt(attempt)}</span>
                <span className="muted logins__meta">{describeLoginPlace(attempt)}</span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="muted twofa__hint" data-logins-retention>
        {retentionDays > 0
          ? t('lh.retention', { count: attempts.length, days: retentionDays })
          : t('lh.hint')}
      </p>
    </div>
  )
}

/**
 * Что произошло — словами, а не кодом из базы.
 *
 * Коды (`bad_password`, `ok`, `recovery`) — наши внутренние имена; человеку нужно «неверный
 * пароль» и «вход по коду восстановления», иначе журнал бесполезен.
 */
export function describeLoginAttempt(attempt: LoginAttempt): string {
  switch (attempt.outcome) {
    case 'ok':
      switch (attempt.factor) {
        case 'password':
          return tStatic('lh.byPassword')
        case 'totp':
          return tStatic('lh.byTotp')
        case 'recovery':
          return tStatic('lh.byRecovery')
        case 'passkey':
          return tStatic('lh.byPasskey')
        default:
          return tStatic('lh.ok')
      }
    case 'bad_password':
      return tStatic('lh.badPassword')
    case 'bad_code':
      return tStatic('lh.badCode')
    case 'bad_key':
      return tStatic('lh.badKey')
    case 'locked':
      return tStatic('lh.badRate')
    case 'request_pending':
      return tStatic('lh.badPending')
    case 'request_rejected':
      return tStatic('lh.badRejected')
    default:
      // Неизвестный исход не прячем: «неизвестно» честнее, чем пустая строка.
      return tStatic('lh.unknown')
  }
}

/** Где и когда: браузер, адрес, дата. */
export function describeLoginPlace(attempt: LoginAttempt): string {
  const parts: string[] = []
  const browser = describeBrowser(attempt.userAgent)
  if (browser) parts.push(browser)
  if (attempt.ip) parts.push(attempt.ip)
  if (attempt.createdAt) {
    const date = new Date(attempt.createdAt)
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleString('ru-RU'))
  }
  return parts.join(' · ')
}
