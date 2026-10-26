import { useCallback, useEffect, useState } from 'react'
import {
  disableTOTP,
  enableTOTP,
  listSessions,
  revokeOtherSessions,
  setupTOTP,
  type AuthSession,
} from '../../api/auth'
import { useAuthStore } from '../../store/auth'
import { PasskeySettings } from './PasskeySettings'

/**
 * Второй фактор входа и активные сеансы.
 *
 * Почему в профиле, а не в админке. Это личная настройка безопасности: включить её должен
 * мочь каждый сам, а выключить — только предъявив код (иначе украденная сессия снимала бы
 * защиту). Отдельного «администратор сбросил 2FA» здесь нет намеренно: сброс требует
 * доказать личность, а доказать её без пароля и кода нечем — это осознанно не сделано,
 * а не забыто (docs/security.md).
 *
 * QR-кода нет: секрет показывается текстом и ссылкой `otpauth://`. Рисовать QR значило бы
 * тянуть библиотеку ради удобства; секрет вводится в приложение вручную.
 */

type Stage = 'idle' | 'setup' | 'codes'

export function TwoFactorSettings() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const enabled = user?.totp_enabled === true

  const [stage, setStage] = useState<Stage>('idle')
  const [secret, setSecret] = useState('')
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [disableCode, setDisableCode] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [sessions, setSessions] = useState<AuthSession[]>([])

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch {
      setSessions([])
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const start = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const setup = await setupTOTP()
      setSecret(setup.secret)
      setUrl(setup.url)
      setStage('setup')
      setCode('')
    } catch {
      setNote('Не удалось начать настройку — попробуйте ещё раз.')
    } finally {
      setBusy(false)
    }
  }, [])

  const confirm = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await enableTOTP(code.trim())
      setCodes(result.recovery_codes ?? [])
      setStage('codes')
      // Профиль перечитываем: признак «включено» рисуется по нему.
      if (user) setUser({ ...user, totp_enabled: true })
    } catch {
      setNote('Код не подошёл. Проверьте время на телефоне и введите код заново.')
    } finally {
      setBusy(false)
    }
  }, [code, user, setUser])

  const turnOff = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      await disableTOTP(disableCode.trim())
      setDisableCode('')
      if (user) setUser({ ...user, totp_enabled: false })
      setNote('Двухфакторный вход выключен: теперь для входа достаточно пароля.')
    } catch {
      setNote('Код не подошёл — вход остался двухфакторным.')
    } finally {
      setBusy(false)
    }
  }, [disableCode, user, setUser])

  const closeOthers = useCallback(async () => {
    setBusy(true)
    setNote(null)
    try {
      const revoked = await revokeOtherSessions()
      setNote(
        revoked > 0
          ? `Закрыто сеансов: ${revoked}. Этот браузер остался в аккаунте.`
          : 'Других активных сеансов не было.',
      )
      await loadSessions()
    } catch {
      setNote('Не удалось закрыть другие сеансы.')
    } finally {
      setBusy(false)
    }
  }, [loadSessions])

  return (
    <section className="twofa" data-two-factor>
      <h3 style={{ marginTop: 0 }}>Вход и устройства</h3>

      <div className="twofa__row">
        <strong>Двухфакторный вход</strong>
        <span className="muted" data-totp-state={enabled ? 'on' : 'off'}>
          {enabled ? 'включён' : 'выключен'}
        </span>
      </div>
      <p className="muted twofa__hint">
        Пароль — единственный фактор, пока не включён второй. Код из приложения-аутентификатора
        защищает вход, даже если пароль утечёт.
      </p>

      {!enabled && stage === 'idle' && (
        <button type="button" onClick={() => void start()} disabled={busy} data-totp-enable>
          {busy ? 'Готовлю…' : 'Включить двухфакторный вход'}
        </button>
      )}

      {!enabled && stage === 'setup' && (
        <div className="twofa__setup">
          <p className="muted">
            Добавьте секрет в приложение (Aegis, Google Authenticator, 1Password) и введите код,
            который оно покажет. Секрет показывается один раз.
          </p>
          <code className="twofa__secret" data-totp-secret>{secret}</code>
          <p className="muted twofa__url">{url}</p>
          <div className="twofa__form">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="код из приложения"
              inputMode="numeric"
              aria-label="Код подтверждения"
            />
            <button type="button" onClick={() => void confirm()} disabled={busy || code.trim() === ''}>
              {busy ? 'Проверяю…' : 'Включить'}
            </button>
          </div>
        </div>
      )}

      {stage === 'codes' && (
        <div className="twofa__codes" data-totp-codes>
          <p>
            <strong>Коды восстановления.</strong> Каждый — одноразовый, заменяет телефон при
            входе. Показываются один раз: сохраните их в надёжном месте.
          </p>
          <ul>
            {codes.map((recovery) => (
              <li key={recovery}>
                <code>{recovery}</code>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => setStage('idle')}>
            Я сохранил коды
          </button>
        </div>
      )}

      {enabled && (
        <div className="twofa__form">
          <input
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            placeholder="код приложения или восстановления"
            aria-label="Код для отключения"
          />
          <button type="button" className="secondary ed-danger" onClick={() => void turnOff()} disabled={busy}>
            Выключить
          </button>
        </div>
      )}

      <h4 className="twofa__subhead">Активные сеансы</h4>
      {sessions.length === 0 ? (
        <p className="muted">Активных сеансов не видно (обновите страницу).</p>
      ) : (
        <ul className="twofa__sessions" data-sessions>
          {sessions.map((session) => (
            <li key={session.id}>
              <span>{sessionDescription(session)}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="secondary" onClick={() => void closeOthers()} disabled={busy} data-sessions-revoke>
        Выйти на всех устройствах, кроме этого
      </button>

      {/* Ключи доступа — второй фактор рядом с кодом из приложения (0.65.0). */}
      <PasskeySettings />

      {note !== null && (
        <p className="twofa__note" role="status" data-two-factor-note>
          {note}
        </p>
      )}
    </section>
  )
}

/** Подпись сеанса: браузер из user-agent, адрес и дата входа. */
export function sessionDescription(session: AuthSession): string {
  const agent = session.userAgent || ''
  const browser =
    /Firefox/i.test(agent)
      ? 'Firefox'
      : /Edg\//i.test(agent)
        ? 'Edge'
        : /Chrome/i.test(agent)
          ? 'Chrome'
          : /Safari/i.test(agent)
            ? 'Safari'
            : 'Неизвестный браузер'
  const platform = /Windows/i.test(agent)
    ? 'Windows'
    : /Android/i.test(agent)
      ? 'Android'
      : /iPhone|iPad/i.test(agent)
        ? 'iOS'
        : /Mac OS/i.test(agent)
          ? 'macOS'
          : /Linux/i.test(agent)
            ? 'Linux'
            : ''
  const where = [browser, platform].filter(Boolean).join(' · ')
  const when = session.createdAt ? new Date(session.createdAt).toLocaleString('ru-RU') : ''
  const ip = session.ip ? ` · ${session.ip}` : ''
  return `${where}${ip}${when ? ` · ${when}` : ''}`
}
