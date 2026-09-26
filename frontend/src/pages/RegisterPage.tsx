import { FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { register } from '../api/auth'

export function RegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await register({ email, password, display_name: name })
      nav('/projects')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'register failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1>Регистрация</h1>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: 12 }}>
          <input placeholder="имя" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <input placeholder="пароль (мин. 8)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </div>
        {err && <div className="error">{err}</div>}
        <button type="submit" disabled={loading}>{loading ? '...' : 'Создать'}</button>
      </form>
      <p style={{ marginTop: 16 }} className="muted">
        Уже есть аккаунт? <Link to="/login">Войти</Link>
      </p>
    </div>
  )
}
