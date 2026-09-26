import { Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuthStore } from '../store/auth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const refresh = useAuthStore((s) => s.refreshToken)
  if (!refresh) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}
