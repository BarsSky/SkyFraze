import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { acceptInvitation } from '../api/teams'

/**
 * Страница приглашения — пользователь переходит по ссылке /invitations/{token}.
 * - Если залогинен: автоматически принимает приглашение, редиректит на проект.
 * - Если не залогинен: предлагает войти, потом повторно переходит на эту страницу.
 */
export function AcceptInvitation() {
  const { token } = useParams<{ token: string }>()
  const nav = useNavigate()
  const refresh = useAuthStore((s) => s.refreshToken)
  const access = useAuthStore((s) => s.accessToken)
  const user = useAuthStore((s) => s.user)
  const [status, setStatus] = useState<'loading' | 'ok' | 'login' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [projectId, setProjectId] = useState<string>('')

  useEffect(() => {
    if (!token) {
      setStatus('error')
      setErrMsg('Токен приглашения не указан')
      return
    }
    if (!refresh) {
      // Не залогинен — редиректим на /login с returnUrl
      setStatus('login')
      return
    }
    // Пытаемся принять
    acceptInvitation(token)
      .then((m) => {
        setProjectId(m.project_id)
        setStatus('ok')
        // Редиректим на проект через 1.5 сек
        setTimeout(() => {
          nav(`/projects/${m.project_id}`, { replace: true })
        }, 1500)
      })
      .catch((e: any) => {
        setStatus('error')
        // Попробуем извлечь сообщение из JSON-ответа
        const msg = e?.response?.data?.error || e?.message || 'Не удалось принять приглашение'
        setErrMsg(msg)
      })
  }, [token, refresh, access, nav])

  if (status === 'loading') {
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <p className="muted">Принимаем приглашение…</p>
      </div>
    )
  }

  if (status === 'login') {
    const next = token ? `/invitations/${token}` : '/projects'
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <h2>Приглашение в проект</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          Чтобы принять приглашение, войдите в аккаунт.
        </p>
        <Link to={`/login`}>
          <button>Войти</button>
        </Link>
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          После входа вернитесь по ссылке приглашения.
        </p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <h2>Не удалось принять приглашение</h2>
        <p className="error">{errMsg}</p>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          Возможные причины: приглашение истекло, уже использовано, или вы не тот получатель.
        </p>
        <div style={{ marginTop: 16 }}>
          <Link to="/projects">
            <button className="secondary">К моим проектам</button>
          </Link>
        </div>
      </div>
    )
  }

  // status === 'ok'
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
      <h2 style={{ color: 'var(--success)' }}>✓ Приглашение принято!</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        {user ? `Добро пожаловать в проект, ${user.display_name}!` : 'Приглашение успешно принято'}
      </p>
      <Link to={`/projects/${projectId}`}>
        <button>Открыть проект</button>
      </Link>
      <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        Редирект автоматически через секунду…
      </p>
    </div>
  )
}
