import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import ky from 'ky'

export interface UserPublic {
  id: string
  email: string
  display_name: string
}

interface AuthState {
  accessToken: string | null
  refreshToken: string | null
  user: UserPublic | null
  ready: boolean
  setUser: (u: UserPublic) => void
  setTokens: (a: string, r: string) => void
  setReady: (v: boolean) => void
  bootstrap: () => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      ready: false,

      setUser: (u) => set({ user: u }),
      setTokens: (a, r) => set({ accessToken: a, refreshToken: r }),
      setReady: (v) => set({ ready: v }),

      bootstrap: async () => {
        const state = get()
        if (state.ready) return
        // если есть refresh-токен, но нет access — обменять
        if (state.refreshToken && !state.accessToken) {
          try {
            const r = await ky.post('/api/auth/refresh', {
              json: { refresh: state.refreshToken },
            }).json<{ access: string; refresh: string }>()
            set({ accessToken: r.access, refreshToken: r.refresh, ready: true })
            return
          } catch {
            set({ refreshToken: null, accessToken: null, user: null, ready: true })
            return
          }
        }
        // если есть access-токен — проверить через /me
        if (state.accessToken) {
          try {
            const u = await ky.get('/api/auth/me', {
              headers: { Authorization: `Bearer ${state.accessToken}` },
            }).json<UserPublic>()
            set({ user: u, ready: true })
            return
          } catch {
            // возможно протух — пробуем refresh
            if (state.refreshToken) {
              try {
                const r = await ky.post('/api/auth/refresh', {
                  json: { refresh: state.refreshToken },
                }).json<{ access: string; refresh: string }>()
                const u = await ky.get('/api/auth/me', {
                  headers: { Authorization: `Bearer ${r.access}` },
                }).json<UserPublic>()
                set({ accessToken: r.access, refreshToken: r.refresh, user: u, ready: true })
                return
              } catch {
                set({ refreshToken: null, accessToken: null, user: null, ready: true })
                return
              }
            }
          }
        }
        set({ ready: true })
      },

      logout: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    {
      name: 'skyfraze-auth',
      partialize: (s) => ({ refreshToken: s.refreshToken, user: s.user }),
    },
  ),
)
