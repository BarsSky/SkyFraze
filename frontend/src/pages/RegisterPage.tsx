import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { authConfig, register, requestRegistration, type RegistrationMode } from '../api/auth'

/**
 * Регистрация зависит от решения администратора инсталляции:
 *   * open    — обычная регистрация, аккаунт создаётся сразу;
 *   * request — заявка: аккаунт появится после одобрения (по умолчанию).
 * Режим спрашиваем у сервера до отправки формы, иначе человек заполнит не ту форму.
 */
export function RegisterPage() {
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
      setErr(describeError(e))
    } finally {
      setLoading(false)
    }
  }

  if (mode === null) {
    return (
      <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
        <p className="muted">Загрузка…</p>
      </div>
    )
  }

  if (sent) {
    return (
      <div style={{ maxWidth: 420, margin: '80px auto', padding: 24 }}>
        <h1>Заявка отправлена</h1>
        <p className="muted">
          Администратор рассмотрит заявку для <b>{email}</b>. Войти можно будет тем паролем,
          который вы указали, — сразу после одобрения.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link to="/login">← Ко входу</Link>
        </p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 420, margin: '80px auto', padding: 24 }}>
      <h1>{direct ? (mode === 'open' ? 'Регистрация' : 'Первый администратор') : 'Заявка на доступ'}</h1>
      <p className="muted">
        {mode === 'open'
          ? 'Регистрация открыта: аккаунт создаётся сразу.'
          : bootstrap
            ? 'Инсталляция ещё пустая: аккаунт, созданный первым, становится администратором и дальше регистрация идёт по заявке.'
            : 'Регистрация на этой инсталляции — по заявке. Опишите, зачем нужен доступ: администратор рассмотрит заявку.'}
      </p>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 12 }}>
          <input placeholder="имя" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input
            placeholder="пароль (мин. 8)"
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
              placeholder="чем занимаетесь / зачем доступ (необязательно)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
          </div>
        )}
        {err && <div className="error">{err}</div>}
        <button type="submit" disabled={loading}>
          {loading ? '…' : direct ? 'Создать' : 'Отправить заявку'}
        </button>
      </form>
      <p style={{ marginTop: 16 }} className="muted">
        Уже есть аккаунт? <Link className="auth-inline-link" to="/login">Войти</Link>
      </p>
      <p className="muted" style={{ marginTop: 8 }}>
        <Link className="auth-inline-link" to="/feed">Публичные истории</Link> можно смотреть без аккаунта.
      </p>
    </div>
  )
}

/** Ошибки API приходят как {error: "..."} — переводим в понятный текст. */
function describeError(e: unknown): string {
  const status = (e as { response?: Response })?.response?.status
  if (status === 409) return 'Этот email уже занят или заявка с ним уже на рассмотрении.'
  if (status === 403) return 'Регистрация закрыта: доступ выдаётся по заявке.'
  if (status === 400) return 'Проверьте поля: имя, email и пароль (минимум 8 символов).'
  return e instanceof Error ? e.message : 'Не удалось отправить заявку'
}
