import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/auth'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await login({ email, password })
      nav('/projects')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1>SkyFraze</h1>
      <p className="muted">Войдите в аккаунт</p>
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
      <p style={{ marginTop: 16 }} className="muted">
        Нет аккаунта? <Link to="/register">Регистрация</Link>
      </p>
    </div>
  )
}
