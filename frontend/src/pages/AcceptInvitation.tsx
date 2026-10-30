import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { acceptInvitation } from '../api/teams'

/**
 * Страница приглашения — пользователь переходит по ссылке /invitations/{token}.
 * - Если залогинен: автоматически принимает приглашение, редиректит на проект.
 * - Если не залогинен: предлагает войти, потом повторно переходит на эту страницу.
 */
export function AcceptInvitation() {
  const t = useT()
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
      setErrMsg(t('acc.noToken'))
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
        const msg = e?.response?.data?.error || e?.message || t('acc.failed')
        setErrMsg(msg)
      })
  }, [token, refresh, access, nav])

  if (status === 'loading') {
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <p className="muted">{t('acc.accepting')}</p>
      </div>
    )
  }

  if (status === 'login') {
    const next = token ? `/invitations/${token}` : '/projects'
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <h2>{t('acc.title')}</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          {t('acc.loginHint')}
        </p>
        <Link to={`/login`}>
          <button>{t('acc.login')}</button>
        </Link>
        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
          {t('acc.loginReturn')}
        </p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
        <h2>{t('acc.failTitle')}</h2>
        <p className="error">{errMsg}</p>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          {t('acc.failHint')}
        </p>
        <div style={{ marginTop: 16 }}>
          <Link to="/projects">
            <button className="secondary">{t('acc.toProjects')}</button>
          </Link>
        </div>
      </div>
    )
  }

  // status === 'ok'
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, textAlign: 'center' }}>
      <h2 style={{ color: 'var(--success)' }}>{t('acc.doneTitle')}</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        {user ? t('acc.welcome', { name: user.display_name }) : t('acc.done')}
      </p>
      <Link to={`/projects/${projectId}`}>
        <button>{t('acc.open')}</button>
      </Link>
      <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        {t('acc.redirect')}
      </p>
    </div>
  )
}
