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
  /** Присылать письма о новых замечаниях (по умолчанию нет). */
  notify_comments?: boolean
  /** Включён ли второй фактор входа (docs/security.md). */
  totp_enabled?: boolean
  /**
   * Настроены ли на стенде ключи доступа (docs/webauthn.md). Профиль по этому признаку
   * показывает раздел ключей: предлагать кнопку, которая всегда отвечает «не настроено»,
   * хуже, чем не предлагать её вовсе.
   */
  passkeys_enabled?: boolean
}

/** Как на этой инсталляции пускают новых пользователей. */
export type RegistrationMode = 'request' | 'open'

export interface AuthConfig {
  registration_mode: RegistrationMode
  /** Инсталляция ещё пустая: первый аккаунт создаёт её и становится администратором. */
  bootstrap?: boolean
  /** На стенде настроены ключи доступа (WebAuthn). */
  passkeys?: boolean
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

/**
 * Вход. Два возможных ответа, и это не «неопределённость», а второй фактор:
 * сервер отвечает `{totp_required, challenge, totp, passkeys}` когда пароля мало, и токены
 * выдаются только после второго шага. Возвращаем размеченное объединение — пусть забыть
 * проверить его нельзя.
 *
 * `totp` и `passkeys` говорят, ЧЕМ этот второй шаг можно пройти: кодом из приложения, ключом
 * доступа или и тем и другим. Это не украшение ответа — от них зависит, какие кнопки показать
 * (docs/webauthn.md §7). Старый сервер этих полей не присылает, тогда считаем «только код».
 */
export type LoginResult =
  | { kind: 'two-factor'; challenge: string; totp: boolean; passkeys: boolean }
  | { kind: 'ok'; user: UserPublic }

export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const raw = await http.post('auth/login', { json: input }).json<unknown>()
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (record?.totp_required === true) {
    return {
      kind: 'two-factor',
      challenge: String(record.challenge ?? ''),
      totp: record.totp === true,
      passkeys: record.passkeys === true,
    }
  }
  const r = raw as { user: UserPublic; tokens: { access: string; refresh: string } }
  useAuthStore.getState().setTokens(r.tokens.access, r.tokens.refresh)
  useAuthStore.getState().setUser(r.user)
  return { kind: 'ok', user: r.user }
}

/** Второй шаг входа: пропуск из первого шага + код приложения (или код восстановления). */
export async function loginTOTP(challenge: string, code: string): Promise<UserPublic> {
  const r = await http
    .post('auth/login/2fa', { json: { challenge, code } })
    .json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
  useAuthStore.getState().setTokens(r.tokens.access, r.tokens.refresh)
  useAuthStore.getState().setUser(r.user)
  return r.user
}

/** Настройка 2FA: секрет и ссылка otpauth (QR не рисуем — секрет можно ввести руками). */
export interface TOTPSetup {
  secret: string
  url: string
  hint?: string
}

export async function setupTOTP(): Promise<TOTPSetup> {
  return await http.post('auth/2fa/setup').json<TOTPSetup>()
}

export async function enableTOTP(code: string): Promise<{ recovery_codes: string[]; note?: string }> {
  return await http
    .post('auth/2fa/enable', { json: { code } })
    .json<{ recovery_codes: string[]; note?: string }>()
}

export async function disableTOTP(code: string): Promise<void> {
  await http.post('auth/2fa/disable', { json: { code } })
}

/** Активный сеанс: где и когда человек вошёл. */
export interface AuthSession {
  id: string
  userAgent: string
  ip: string
  createdAt: string
  expiresAt: string
}

export async function listSessions(): Promise<AuthSession[]> {
  const raw = await http.get('auth/sessions').json<unknown>()
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  const list = Array.isArray(record?.sessions) ? record?.sessions : []
  const out: AuthSession[] = []
  for (const item of list as Array<Record<string, unknown>>) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!id) continue
    out.push({
      id,
      userAgent: typeof item.user_agent === 'string' ? item.user_agent : '',
      ip: typeof item.ip === 'string' ? item.ip : '',
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      expiresAt: typeof item.expires_at === 'string' ? item.expires_at : '',
    })
  }
  return out
}

/** Закрыть все сеансы, кроме текущего браузера. */
export async function revokeOtherSessions(): Promise<number> {
  const refresh = useAuthStore.getState().refreshToken ?? ''
  const raw = await http
    .post('auth/sessions/revoke-others', { json: { refresh } })
    .json<{ revoked?: number }>()
  return typeof raw?.revoked === 'number' ? raw.revoked : 0
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
  /**
   * Присылать письма о новых замечаниях. По умолчанию выключено: текст проекта уходит на
   * почтовый сервер только по осознанному согласию (docs/comments.md §5.2).
   */
  notify_comments?: boolean
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
