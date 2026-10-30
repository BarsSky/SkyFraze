import { http, serverErrorMessage } from './client'
import { tStatic } from '../i18n'
import { useAuthStore } from '../store/auth'
import type { UserPublic } from './auth'

/**
 * Ключи доступа в браузере: обёртка над `navigator.credentials` и ручками сервера.
 *
 * Зачем отдельный модуль. WebAuthn в браузере — это преобразование base64url ↔ ArrayBuffer в
 * обе стороны и разбор того, что вернул аутентификатор. Ошибка здесь не «не работает», а
 * «сервер говорит: неверный ответ» без объяснений, поэтому преобразования вынесены в чистые
 * функции и проверены тестами отдельно от компонентов.
 *
 * Что важно помнить про поток (docs/webauthn.md §6):
 *   - привязка: begin → navigator.credentials.create() → finish (тело — ответ аутентификатора);
 *   - вход ключом — ВТОРОЙ шаг: сначала пароль, потом пропуск, потом ключ. Ключ заменяет код
 *     из приложения, а не пароль.
 */

/** Ключ доступа в том виде, в каком его знает сервер (приватной части нет и быть не может). */
export interface PasskeyKey {
  id: string
  name: string
  created_at: string
  last_used_at?: string
  transports: string
}

/** Описание ключа в опциях церемонии: идентификатор приезжает строкой base64url. */
interface DescriptorJSON {
  type: 'public-key'
  id: string
  transports?: string[]
}

/** Опции создания ключа — как их отдаёт сервер (JSON, base64url строками). */
export interface CreationOptionsJSON {
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>
  timeout?: number
  excludeCredentials?: DescriptorJSON[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: string
}

/** Опции запроса подписи — как их отдаёт сервер. */
export interface RequestOptionsJSON {
  challenge: string
  timeout?: number
  rpId?: string
  allowCredentials?: DescriptorJSON[]
  userVerification?: UserVerificationRequirement
}

/**
 * base64url → байты. Без padding: браузер и сервер передают его без «=».
 *
 * Возвращаемый тип — `Uint8Array<ArrayBuffer>`, а не просто `Uint8Array`: с TypeScript 5.7
 * типизированные массивы параметризованы буфером, и `ArrayBufferLike` (куда входит
 * `SharedArrayBuffer`) в `BufferSource` из lib.dom не подходит. Это не придирка типа: WebAuthn
 * действительно требует обычный ArrayBuffer.
 */
export function decodeBase64URL(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const buffer = new ArrayBuffer(binary.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** байты → base64url без padding (именно так их ждёт сервер). */
export function encodeBase64URL(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Есть ли в браузере WebAuthn. В jsdom и старых браузерах — нет, и это отвечено честно. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  )
}

/** Опции создания: строки становятся байтами, остальное передаётся как есть. */
export function toCreationOptions(src: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    rp: src.rp,
    user: {
      id: decodeBase64URL(src.user.id),
      name: src.user.name,
      displayName: src.user.displayName,
    },
    challenge: decodeBase64URL(src.challenge),
    pubKeyCredParams: src.pubKeyCredParams,
    timeout: src.timeout,
    excludeCredentials: (src.excludeCredentials ?? []).map((d) => ({
      type: 'public-key' as const,
      id: decodeBase64URL(d.id),
      transports: d.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: src.authenticatorSelection,
    attestation: (src.attestation ?? 'none') as AttestationConveyancePreference,
  }
}

/** Опции запроса подписи. */
export function toRequestOptions(src: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    challenge: decodeBase64URL(src.challenge),
    timeout: src.timeout,
    rpId: src.rpId,
    allowCredentials: (src.allowCredentials ?? []).map((d) => ({
      type: 'public-key' as const,
      id: decodeBase64URL(d.id),
      transports: d.transports as AuthenticatorTransport[] | undefined,
    })),
    userVerification: src.userVerification,
  }
}

/**
 * Тело привязки: то, что сервер разбирает библиотекой.
 *
 * Перечисляем поля явно, а не сериализуем объект браузера целиком: `PublicKeyCredential`
 * полон внутренностей, и «JSON.stringify на всё» отправил бы серверу не то, что он ждёт.
 */
export function registrationBody(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: encodeBase64URL(cred.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encodeBase64URL(response.clientDataJSON),
      attestationObject: encodeBase64URL(response.attestationObject),
    },
  }
}

/** Тело подписи при входе. */
export function assertionBody(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: encodeBase64URL(cred.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encodeBase64URL(response.clientDataJSON),
      authenticatorData: encodeBase64URL(response.authenticatorData),
      signature: encodeBase64URL(response.signature),
      userHandle: response.userHandle ? encodeBase64URL(response.userHandle) : null,
    },
  }
}

/** Список ключей человека. */
export async function listPasskeys(): Promise<PasskeyKey[]> {
  const raw = await http.get('auth/keys').json<{ keys?: PasskeyKey[] }>()
  return Array.isArray(raw?.keys) ? raw.keys : []
}

/** Удаление ключа. */
export async function deletePasskey(id: string): Promise<void> {
  await http.delete(`auth/keys/${encodeURIComponent(id)}`)
}

/**
 * Привязка ключа: begin → окно браузера → finish.
 *
 * `recoveryCodes` не пуст, когда сервер выдал коды восстановления ВПЕРВЫЕ (их не было):
 * это последний путь в аккаунт, если устройство потеряется, и показывать их надо сразу.
 */
export async function addPasskey(
  name: string,
): Promise<{ key: PasskeyKey; recoveryCodes: string[] }> {
  const begin = await http
    .post('auth/keys/register/begin')
    .json<{ challenge: string; publicKey: CreationOptionsJSON }>()
  const cred = (await navigator.credentials.create({
    publicKey: toCreationOptions(begin.publicKey),
  })) as PublicKeyCredential | null
  if (!cred) throw new Error(tStatic('wa.noKey'))
  // Имя и пропуск — в строке запроса: тело занято ответом аутентификатора, иначе пришлось бы
  // разбирать и собирать его заново, рискуя проверить подпись не над тем, что пришло.
  const url =
    `auth/keys/register/finish?challenge=${encodeURIComponent(begin.challenge)}` +
    `&name=${encodeURIComponent(name)}`
  const done = await http.post(url, { json: registrationBody(cred) }).json<{
    key: PasskeyKey
    recovery_codes?: string[]
  }>()
  return { key: done.key, recoveryCodes: done.recovery_codes ?? [] }
}

/**
 * Вход ключом — второй шаг после пароля. `ticket` — пропуск из ответа `login`.
 *
 * Ключ доказывает и владение устройством, и присутствие человека (PIN, отпечаток), поэтому
 * код из приложения после него не нужен.
 */
export async function loginWithPasskey(ticket: string): Promise<UserPublic> {
  const begin = await http
    .post('auth/login/webauthn/begin', { json: { challenge: ticket } })
    .json<{ challenge: string; publicKey: RequestOptionsJSON }>()
  const cred = (await navigator.credentials.get({
    publicKey: toRequestOptions(begin.publicKey),
  })) as PublicKeyCredential | null
  if (!cred) throw new Error(tStatic('wa.noSignature'))
  const done = await http
    .post(
      `auth/login/webauthn/finish?challenge=${encodeURIComponent(begin.challenge)}`,
      { json: assertionBody(cred) },
    )
    .json<{ user: UserPublic; tokens: { access: string; refresh: string } }>()
  useAuthStore.getState().setTokens(done.tokens.access, done.tokens.refresh)
  useAuthStore.getState().setUser(done.user)
  return done.user
}

/**
 * Объяснение отказа словами.
 *
 * Три самых частых случая узнаваемы, и «InvalidStateError» человеку ничего не говорит:
 * окно закрыли, такой ключ уже привязан, браузер не умеет. Остальное — как есть.
 */
export async function describePasskeyError(e: unknown): Promise<string> {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError') return tStatic('wa.notAllowed')
  if (name === 'InvalidStateError') return tStatic('wa.invalidState')
  if (name === 'NotSupportedError') return tStatic('wa.notSupported')
  if (e instanceof Error && e.message === tStatic('wa.noKey')) {
    return tStatic('wa.notCreated')
  }
  if (e instanceof Error && e.message === tStatic('wa.noSignature')) {
    return tStatic('wa.notConfirmed')
  }
  const server = await serverErrorMessage(e)
  return server ?? tStatic('wa.failed')
}
