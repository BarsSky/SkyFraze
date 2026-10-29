import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login, loginTOTP } from '../api/auth'
import { describePasskeyError, loginWithPasskey, passkeysSupported } from '../api/webauthn'
import { useT, type TFunction } from '../i18n'

/**
 * Вход.
 *
 * Два шага, и второй — не «ещё одна форма», а выбор способа: код из приложения или ключ
 * доступа (docs/webauthn.md §7). Какие способы доступны, говорит сервер в ответе на пароль
 * (`totp`, `passkeys`) — до пароля это знание ничего не даёт, а после даёт, и скрывать его
 * незачем.
 */

interface SecondStep {
  challenge: string
  totp: boolean
  passkeys: boolean
}

export function LoginPage() {
  const t = useT()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  /** Пропуск второго шага: не пустой — значит, пароль принят и ждём второй фактор. */
  const [second, setSecond] = useState<SecondStep | null>(null)
  const [code, setCode] = useState('')
  /**
   * Показать поле кода восстановления, когда включён только ключ.
   *
   * Зачем отдельное состояние: если у человека есть ключ и нет TOTP, поля кода на экране не
   * должно быть «по умолчанию» (кода из приложения у него не существует), но коды
   * восстановления у него ЕСТЬ — их выдали при привязке ключа. Без этой кнопки потерянный
   * ключ означал бы потерянный аккаунт, хотя код лежит у него на листке.
   */
  const [useRecovery, setUseRecovery] = useState(false)
  const nav = useNavigate()

  const canUseKey = second?.passkeys === true && passkeysSupported()
  // Код показываем, если он вообще возможен. Старый сервер не присылал `totp` — тогда
  // считаем, что код есть, и не отнимаем у человека единственный способ входа.
  const canUseCode = second !== null && (second.totp || !second.passkeys)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      const result = await login({ email, password })
      if (result.kind === 'two-factor') {
        // Пароль верный, но токенов ещё нет: показываем второй шаг. Пароль остаётся в
        // состоянии — если человек вернётся назад, вводить его заново не придётся.
        setSecond({ challenge: result.challenge, totp: result.totp, passkeys: result.passkeys })
        return
      }
      nav('/projects')
    } catch (e: unknown) {
      setErr(await describeLoginError(e, t))
    } finally {
      setLoading(false)
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault()
    if (second === null) return
    setErr('')
    setLoading(true)
    try {
      await loginTOTP(second.challenge, code.trim())
      nav('/projects')
    } catch (e: unknown) {
      setErr(await describeLoginError(e, t))
    } finally {
      setLoading(false)
    }
  }

  async function onUseKey() {
    if (second === null) return
    setErr('')
    setLoading(true)
    try {
      await loginWithPasskey(second.challenge)
      nav('/projects')
    } catch (e: unknown) {
      const message = await describePasskeyError(e)
      // Пропуск второго шага живёт 5 минут: если он истёк, честнее вернуть к паролю, чем
      // оставить человека нажимать кнопку, которая уже не сработает.
      setErr(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1>SkyFraze</h1>
      <p className="muted">{t('login.subtitle')}</p>
      {second === null ? (
        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: 12 }}>
            <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div style={{ marginBottom: 12 }}>
            <input placeholder={t('login.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {err && <div className="error">{err}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : t('login.submit')}</button>
        </form>
      ) : (
        <div data-login-2fa>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('login.passwordAccepted')}{' '}
            {canUseKey && canUseCode
              ? t('login.confirmBoth')
              : canUseKey
                ? t('login.confirmKey')
                : t('login.confirmCode')}
          </p>

          {canUseKey && (
            <div style={{ marginBottom: 12 }}>
              <button type="button" onClick={() => void onUseKey()} disabled={loading} data-login-passkey>
                {loading ? '...' : t('login.passkey')}
              </button>
            </div>
          )}

          {/* Ключ потерян — а коды восстановления у человека есть (их выдают при привязке
              ключа). Без этой кнопки последний путь в аккаунт существовал бы только в
              документации: поля для кода на экране нет, когда TOTP не включён. */}
          {canUseKey && !canUseCode && !useRecovery && (
            <p className="muted" style={{ marginBottom: 12 }}>
              {t('login.noKey')}{' '}
              <button
                type="button"
                className="secondary"
                onClick={() => setUseRecovery(true)}
                disabled={loading}
                data-login-use-recovery
              >
                {t('login.useRecovery')}
              </button>
            </p>
          )}

          {(canUseCode || useRecovery) && (
            <form onSubmit={onSubmitCode}>
              <div style={{ marginBottom: 12 }}>
                <input
                  placeholder={canUseCode ? t('login.codeApp') : t('login.codeRecovery')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode={canUseCode ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  autoFocus={!canUseKey}
                  required
                  aria-label={
                    canUseCode ? t('login.codeAppAria') : t('login.codeRecoveryAria')
                  }
                />
              </div>
              <button type="submit" disabled={loading}>{loading ? '...' : t('login.confirm')}</button>
            </form>
          )}

          {err && <div className="error">{err}</div>}
          <p className="muted" style={{ marginTop: 12 }}>
            {canUseCode && <>{t('login.noPhone')} </>}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setSecond(null)
                setCode('')
                setErr('')
                // «Назад» возвращает к паролю: следующий вход снова начинается с того, что
                // человек знает, а не с выбранного способа.
                setUseRecovery(false)
              }}
            >
              {t('login.back')}
            </button>
          </p>
        </div>
      )}
      <p style={{ marginTop: 16 }} className="muted auth-links">
        {t('login.noAccount')} <Link className="auth-inline-link" to="/register">{t('login.register')}</Link>
      </p>
      <p className="muted" style={{ marginTop: 8 }}>
        <Link className="auth-inline-link" to="/feed">{t('login.publicStories')}</Link> {t('login.publicStoriesNoAuth')}
      </p>
    </div>
  )
}

/**
 * 403 при входе означает не «нет прав вообще», а состояние заявки: сервер
 * различает «на рассмотрении» и «отклонена», и человеку нужно объяснить, что делать.
 *
 * Тексты берутся из словаря через `t` (0.115.0): сообщение об ошибке — такая же подпись
 * интерфейса, как кнопка, и при переключении языка оно тоже должно меняться.
 */
async function describeLoginError(e: unknown, t: TFunction): Promise<string> {
  const res = (e as { response?: Response })?.response
  if (res?.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null
    if (body?.error?.includes('rejected')) return t('login.errRejected')
    return t('login.errPending')
  }
  if (res?.status === 401) return t('login.errBadCreds')
  if (res?.status === 429) return t('login.errTooMany')
  return e instanceof Error ? e.message : t('login.errFailed')
}
