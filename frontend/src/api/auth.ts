import { http } from './client'
import { useAuthStore } from '../store/auth'

export interface UserPublic {
  id: string
  email: string
  display_name: string
  /** Администратор развёртывания: режим регистрации и заявки */
  is_admin: boolean
}

/** Как на этой инсталляции пускают новых пользователей. */
export type RegistrationMode = 'request' | 'open'

export interface AuthConfig {
  registration_mode: RegistrationMode
  /** Инсталляция ещё пустая: первый аккаунт создаёт её и становится администратором. */
  bootstrap?: boolean
}

/** Публичная конфигурация входа: нужна до отправки формы регистрации. */
export async function authConfig(): Promise<AuthConfig> {
  return await http.get('auth/config').json<AuthConfig>()
}

export async function register(input: { email: string; password: string; display_name: string }) {
  const r = await http
    .post('auth/register', { json: input })
    .json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
  useAuthStore.getState().setTokens(r.tokens.access, r.tokens.refresh)
  useAuthStore.getState().setUser(r.user)
  return r.user
}

/** Заявка на доступ (режим «по заявке»): аккаунт создаст администратор. */
export async function requestRegistration(input: {
  email: string
  password: string
  display_name: string
  message?: string
}): Promise<{ status: string; email: string }> {
  return await http
    .post('auth/registration-requests', { json: input })
    .json<{ status: string; email: string }>()
}

export async function login(input: { email: string; password: string }) {
  const r = await http
    .post('auth/login', { json: input })
    .json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
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
