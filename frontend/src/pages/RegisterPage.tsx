import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authConfig, register, requestRegistration, type RegistrationMode } from '../api/auth'
import { useT, type TFunction } from '../i18n'

/**
 * Регистрация зависит от решения администратора инсталляции:
 *   * open    — обычная регистрация, аккаунт создаётся сразу;
 *   * request — заявка: аккаунт появится после одобрения (по умолчанию).
 * Режим спрашиваем у сервера до отправки формы, иначе человек заполнит не ту форму.
 */
export function RegisterPage() {
  const t = useT()
  const [mode, setMode] = useState<RegistrationMode | null>(null)
  const [bootstrap, setBootstrap] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()

  useEffect(() => {
    authConfig()
      .then((c) => {
        setMode(c.registration_mode)
        setBootstrap(Boolean(c.bootstrap))
      })
      .catch(() => setMode('request'))
  }, [])

  // Прямая регистрация возможна в открытом режиме и на пустой инсталляции
  // (первый аккаунт — создатель инсталляции), во всех остальных случаях — заявка.
  const direct = mode === 'open' || (mode === 'request' && bootstrap)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      if (direct) {
        await register({ email, password, display_name: name })
        nav('/projects')
        return
      }
      await requestRegistration({ email, password, display_name: name, message })
      setSent(true)
    } catch (e: unknown) {
      setErr(describeError(e, t))
    } finally {
      setLoading(false)
    }
  }

  if (mode === null) {
    return (
      <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
        <p className="muted">{t('register.loading')}</p>
      </div>
    )
  }

  if (sent) {
    return (
      <div style={{ maxWidth: 420, margin: '80px auto', padding: 24 }}>
        <h1>{t('register.sentTitle')}</h1>
        <p className="muted">
          {t('register.sentTextPrefix')} <b>{email}</b>. {t('register.sentTextSuffix')}
        </p>
        <p style={{ marginTop: 16 }}>
          <Link to="/login">{t('register.toLogin')}</Link>
        </p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', padding: 24 }}>
      <h1>
        {direct ? (mode === 'open' ? t('register.titleOpen') : t('register.titleBootstrap')) : t('register.titleRequest')}
      </h1>
      <p className="muted">
        {mode === 'open'
          ? t('register.hintOpen')
          : bootstrap
            ? t('register.hintBootstrap')
            : t('register.hintRequest')}
      </p>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 12 }}>
          <input placeholder={t('register.name')} value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input placeholder={t('register.email')} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input
            placeholder={t('register.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {!direct && (
          <div style={{ marginBottom: 12 }}>
            <textarea
              placeholder={t('register.message')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <button type="submit" disabled={loading}>
          {loading ? '…' : direct ? t('register.create') : t('register.send')}
        </button>
      </form>
      <p style={{ marginTop: 16 }} className="muted">
        {t('register.haveAccount')} <Link className="auth-inline-link" to="/login">{t('register.login')}</Link>
      </p>
      <p className="muted" style={{ marginTop: 8 }}>
        <Link className="auth-inline-link" to="/feed">{t('register.publicStories')}</Link> {t('register.publicStoriesTail')}
      </p>
    </div>
  )
}

/** Ошибки API приходят как {error: "..."} — переводим в понятный текст (через словарь, 0.115.0). */
function describeError(e: unknown, t: TFunction): string {
  const status = (e as { response?: Response })?.response?.status
  if (status === 409) return t('register.errEmailTaken')
  if (status === 403) return t('register.errClosed')
  if (status === 400) return t('register.errInvalid')
  return e instanceof Error ? e.message : t('register.errFailed')
}
