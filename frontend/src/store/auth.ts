import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface UserPublic {
  id: string
  email: string
  display_name: string
}

interface AuthState {
  accessToken: string | null
  refreshToken: string | null
  user: UserPublic | null
  setUser: (u: UserPublic) => void
  setTokens: (a: string, r: string) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setUser: (u) => set({ user: u }),
      setTokens: (a, r) => set({ accessToken: a, refreshToken: r }),
      logout: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    {
      name: 'skyfraze-auth',
      partialize: (s) => ({ refreshToken: s.refreshToken, user: s.user }),
    },
  ),
)
