import { http } from './client'
import { useAuthStore } from '../store/auth'

export interface UserPublic {
  id: string
  email: string
  display_name: string
  /** Ник (@username): по нему человека находят в поиске соавторов. */
  username: string
  /** Администратор развёртывания: режим регистрации и заявки */
  is_admin: boolean
  /** Короткое резюме о себе (≤600 знаков): его показывает каталог резидентов. */
  bio?: string
  /** Специализации: всегда массив (пустой — если не указаны). */
  crafts?: string[]
  /**
   * Видно ли человека в каталоге резидентов. Приезжает только из /api/auth/me:
   * в объектах каталога этого поля нет. На сервере значение по умолчанию —
   * true, то есть человек виден, пока сам не снял галочку.
   */
  discoverable?: boolean
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

/**
 * Что можно поменять в своём профиле.
 *
 * Контракт PATCH — по полям: поля нет в теле — сервер его не трогает; пришла
 * пустая строка или пустой массив — значение очищается. Поэтому «стереть
 * резюме» и «снять все специализации» выражаются явно: `bio: ''`, `crafts: []`.
 */
export interface ProfilePatch {
  display_name?: string
  username?: string
  /** Резюме о себе, не длиннее 600 знаков; `''` — убрать резюме. */
  bio?: string
  /** Специализации; `[]` — убрать все. */
  crafts?: string[]
  /** Показывать себя в каталоге резидентов; по умолчанию человек виден. */
  discoverable?: boolean
}

/**
 * Профиль: имя, ник, резюме, специализации и видимость в каталоге резидентов.
 * Ник уникален — занятый вернёт 409, и это нормальная ситуация, а не сбой:
 * интерфейс подсказывает взять другой.
 */
export async function updateProfile(input: ProfilePatch): Promise<UserPublic> {
  const user = await http.patch('auth/me', { json: input }).json<UserPublic>()
  useAuthStore.getState().setUser(user)
  return user
}

export function logout() {
  useAuthStore.getState().logout()
}
