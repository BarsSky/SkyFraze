import { http } from './client'
import { useAuthStore } from '../store/auth'

export interface UserPublic {
  id: string
  email: string
  display_name: string
}

export async function register(input: { email: string; password: string; display_name: string }) {
  const r = await http.post('auth/register', { json: input }).json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
  useAuthStore.getState().setTokens(r.tokens.access, r.tokens.refresh)
  useAuthStore.getState().setUser(r.user)
  return r.user
}

export async function login(input: { email: string; password: string }) {
  const r = await http.post('auth/login', { json: input }).json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
  useAuthStore.getState().setTokens(r.tokens.access, r.tokens.refresh)
  useAuthStore.getState().setUser(r.user)
  return r.user
}

export async function me(): Promise<UserPublic> {
  return await http.get('auth/me').json<UserPublic>()
}

export function logout() {
  useAuthStore.getState().logout()
}
