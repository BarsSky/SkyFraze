import { useCallback, useEffect, useState } from 'react'
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
      <h4 className="twofa__subhead">Последние входы</h4>
      {attempts.length === 0 ? (
        <p className="muted" data-logins-empty>
          Записей пока нет. Здесь появятся входы в аккаунт — и неудачные попытки тоже.
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
          ? `Хранятся последние ${attempts.length} записей за ${retentionDays} дней. Не узнаёте вход — смените пароль и привяжите новый ключ.`
          : 'Не узнаёте вход — смените пароль и привяжите новый ключ.'}
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
          return 'Вход по паролю'
        case 'totp':
          return 'Вход по коду из приложения'
        case 'recovery':
          return 'Вход по коду восстановления'
        case 'passkey':
          return 'Вход по ключу доступа'
        default:
          return 'Вход выполнен'
      }
    case 'bad_password':
      return 'Неудачно: неверный пароль'
    case 'bad_code':
      return 'Неудачно: неверный код'
    case 'bad_key':
      return 'Неудачно: ключ не подошёл'
    case 'locked':
      return 'Неудачно: слишком много попыток'
    case 'request_pending':
      return 'Неудачно: заявка ещё не одобрена'
    case 'request_rejected':
      return 'Неудачно: заявка отклонена'
    default:
      // Неизвестный исход не прячем: «неизвестно» честнее, чем пустая строка.
      return 'Неизвестная попытка'
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
