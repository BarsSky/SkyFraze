import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import {
  disableTOTP,
  enableTOTP,
  listSessions,
  revokeOtherSessions,
  setupTOTP,
  type AuthSession,
} from '../../api/auth'
import { useAuthStore } from '../../store/auth'
import { describeBrowser } from '../../lib/agent'
import { LoginHistory } from './LoginHistory'
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
  const t = useT()
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
      setNote(t('tfa.startFailed'))
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
      setNote(t('tfa.codeWrong'))
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
      setNote(t('tfa.disabled'))
    } catch {
      setNote(t('tfa.disableWrongCode'))
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
          ? t('tfa.revoked', { count: revoked })
          : t('tfa.noSessions'),
      )
      await loadSessions()
    } catch {
      setNote(t('tfa.revokeFailed'))
    } finally {
      setBusy(false)
    }
  }, [loadSessions])

  return (
    <section className="twofa" data-two-factor>
      <h3 style={{ marginTop: 0 }}>{t('tfa.title')}</h3>

      <div className="twofa__row">
        <strong>{t('tfa.heading')}</strong>
        <span className="muted" data-totp-state={enabled ? 'on' : 'off'}>
          {enabled ? t('tfa.on') : t('tfa.off')}
        </span>
      </div>
      <p className="muted twofa__hint">
        {t('tfa.explain')}
      </p>

      {!enabled && stage === 'idle' && (
        <button type="button" onClick={() => void start()} disabled={busy} data-totp-enable>
          {busy ? t('tfa.preparing') : t('tfa.enable')}
        </button>
      )}

      {!enabled && stage === 'setup' && (
        <div className="twofa__setup">
          <p className="muted">
            {t('tfa.step2')}
          </p>
          <code className="twofa__secret" data-totp-secret>{secret}</code>
          <p className="muted twofa__url">{url}</p>
          <div className="twofa__form">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('tfa.codePlaceholder')}
              inputMode="numeric"
              aria-label={t('tfa.codeAria')}
            />
            <button type="button" onClick={() => void confirm()} disabled={busy || code.trim() === ''}>
              {busy ? t('tfa.checking') : t('tfa.confirm')}
            </button>
          </div>
        </div>
      )}

      {stage === 'codes' && (
        <div className="twofa__codes" data-totp-codes>
          <p>
            <strong>{t('pk.recoveryTitle')}</strong>
            {t('tfa.recoveryHint')}
          </p>
          <ul>
            {codes.map((recovery) => (
              <li key={recovery}>
                <code>{recovery}</code>
              </li>
            ))}
          </ul>
          <button type="button" className="secondary" onClick={() => setStage('idle')}>
            {t('tfa.savedCodes')}
          </button>
        </div>
      )}

      {enabled && (
        <div className="twofa__form">
          <input
            value={disableCode}
            onChange={(e) => setDisableCode(e.target.value)}
            placeholder={t('tfa.disablePlaceholder')}
            aria-label={t('tfa.disableAria')}
          />
          <button type="button" className="secondary ed-danger" onClick={() => void turnOff()} disabled={busy}>
            {t('tfa.disable')}
          </button>
        </div>
      )}

      <h4 className="twofa__subhead">{t('tfa.sessions')}</h4>
      {sessions.length === 0 ? (
        <p className="muted">{t('tfa.sessionsEmpty')}</p>
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
        {t('tfa.revokeOthers')}
      </button>

      {/* Ключи доступа — второй фактор рядом с кодом из приложения (0.65.0). */}
      <PasskeySettings />

      {/* Журнал входов: «когда я входил» и «кто пытался» (0.66.0). */}
      <LoginHistory />

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
  const where = describeBrowser(session.userAgent)
  const when = session.createdAt ? new Date(session.createdAt).toLocaleString('ru-RU') : ''
  const ip = session.ip ? ` · ${session.ip}` : ''
  return `${where}${ip}${when ? ` · ${when}` : ''}`
}
