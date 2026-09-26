import ky from 'ky'
import { useAuthStore } from '../store/auth'

export const http = ky.create({
  prefixUrl: '/api',
  hooks: {
    beforeRequest: [
      (req) => {
        const tok = useAuthStore.getState().accessToken
        if (tok) {
          req.headers.set('Authorization', `Bearer ${tok}`)
        }
      },
    ],
    afterResponse: [
      async (req, _opts, res) => {
        if (res.status === 401) {
          // пытаемся refresh
          const refreshed = await tryRefresh()
          if (refreshed) {
            const tok = useAuthStore.getState().accessToken
            if (tok) req.headers.set('Authorization', `Bearer ${tok}`)
            return ky(req)
          }
          useAuthStore.getState().logout()
        }
      },
    ],
  },
})

async function tryRefresh(): Promise<boolean> {
  const refresh = useAuthStore.getState().refreshToken
  if (!refresh) return false
  try {
    const resp = await ky.post('/api/auth/refresh', {
      prefixUrl: '',
      json: { refresh },
    }).json<{ access: string; refresh: string }>()
    useAuthStore.getState().setTokens(resp.access, resp.refresh)
    return true
  } catch {
    return false
  }
}
