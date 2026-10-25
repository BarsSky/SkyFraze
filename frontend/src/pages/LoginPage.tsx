import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login, loginTOTP } from '../api/auth'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  /** Пропуск второго шага: не пустой — значит, пароль принят и ждём код. */
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const nav = useNavigate()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      const result = await login({ email, password })
      if (result.kind === 'two-factor') {
        // Пароль верный, но токенов ещё нет: показываем поле кода. Пароль остаётся в
        // состоянии — если человек вернётся назад, вводить его заново не придётся.
        setChallenge(result.challenge)
        return
      }
      nav('/projects')
    } catch (e: unknown) {
      setErr(await describeLoginError(e))
    } finally {
      setLoading(false)
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await loginTOTP(challenge, code.trim())
      nav('/projects')
    } catch (e: unknown) {
      setErr(await describeLoginError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1>SkyFraze</h1>
      <p className="muted">Войдите в аккаунт</p>
      {challenge === '' ? (
        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: 12 }}>
            <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div style={{ marginBottom: 12 }}>
            <input placeholder="пароль" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {err && <div className="error">{err}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Войти'}</button>
        </form>
      ) : (
        <form onSubmit={onSubmitCode} data-login-2fa>
          <p className="muted" style={{ marginTop: 0 }}>
            Пароль принят. Введите код из приложения-аутентификатора.
          </p>
          <div style={{ marginBottom: 12 }}>
            <input
              placeholder="код из приложения"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              aria-label="Код двухфакторного входа"
            />
          </div>
          {err && <div className="error">{err}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Подтвердить'}</button>
          <p className="muted" style={{ marginTop: 12 }}>
            Нет телефона под рукой? Введите один из кодов восстановления.{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setChallenge('')
                setCode('')
                setErr('')
              }}
            >
              Назад
            </button>
          </p>
        </form>
      )}
      <p style={{ marginTop: 16 }} className="muted auth-links">
        Нет аккаунта? <Link className="auth-inline-link" to="/register">Регистрация</Link>
      </p>
      <p className="muted" style={{ marginTop: 8 }}>
        <Link className="auth-inline-link" to="/feed">Публичные истории</Link> — без входа
      </p>
    </div>
  )
}

/**
 * 403 при входе означает не «нет прав вообще», а состояние заявки: сервер
 * различает «на рассмотрении» и «отклонена», и человеку нужно объяснить, что делать.
 */
async function describeLoginError(e: unknown): Promise<string> {
  const res = (e as { response?: Response })?.response
  if (res?.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null
    if (body?.error?.includes('rejected')) return 'Заявка на доступ отклонена администратором.'
    return 'Заявка на доступ ещё не одобрена — дождитесь решения администратора.'
  }
  if (res?.status === 401) return 'Неверный email или пароль (или код двухфакторного входа)'
  if (res?.status === 429) return 'Слишком много попыток — подождите минуту и попробуйте снова.'
  return e instanceof Error ? e.message : 'login failed'
}
