import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useAuthStore } from '../store/auth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const refresh = useAuthStore((s) => s.refreshToken)
  const accessToken = useAuthStore((s) => s.accessToken)
  const user = useAuthStore((s) => s.user)
  const ready = useAuthStore((s) => s.ready)
  const bootstrap = useAuthStore((s) => s.bootstrap)

  useEffect(() => {
    if (!ready) void bootstrap()
  }, [ready, bootstrap])

  // Если есть refresh, но нет access и user — bootstrap пережимает refresh;
  // покажем loading-state чтобы не редиректить мгновенно на login.
  if (!refresh && ready) {
    return <Navigate to="/login" replace />
  }
  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <span className="muted">Загрузка…</span>
      </div>
    )
  }
  // Успешная загрузка: есть refresh и user (или хотя бы refresh, а user придёт из /me).
  if (!refresh) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
