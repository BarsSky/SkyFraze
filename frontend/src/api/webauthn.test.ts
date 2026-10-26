import { describe, expect, it } from 'vitest'
import {
  assertionBody,
  decodeBase64URL,
  encodeBase64URL,
  passkeysSupported,
  registrationBody,
  toCreationOptions,
  toRequestOptions,
} from './webauthn'

/**
 * Преобразования WebAuthn: base64url ↔ байты и разбор того, что вернул браузер.
 *
 * Почему эти тесты важнее компонентных: если ошибиться здесь, сервер ответит «неверный ответ
 * браузера», и человек увидит отказ без причины. Ошибка в одном символе base64url — это
 * другая подпись, и найти её в браузере почти невозможно.
 */

const bytes = (...values: number[]) => new Uint8Array(values)

describe('base64url', () => {
  it('кодирует без padding и без «+»/«/»', () => {
    const encoded = encodeBase64URL(bytes(0xfb, 0xff, 0xbf))
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('переживает круговой обход, включая байты, которые в обычном base64 дают «+» и «/»', () => {
    const original = bytes(0, 1, 2, 250, 251, 255, 62, 63, 128)
    const back = decodeBase64URL(encodeBase64URL(original))
    expect(Array.from(back)).toEqual(Array.from(original))
  })

  it('понимает «-» и «_» вместо «+» и «/» и не требует padding', () => {
    // 0xfb 0xff → обычный base64 «+/8=», base64url «-_8».
    expect(Array.from(decodeBase64URL('-_8'))).toEqual([0xfb, 0xff])
    expect(encodeBase64URL(bytes(0xfb, 0xff))).toBe('-_8')
  })

  it('пустая строка — это пустые байты, а не ошибка', () => {
    expect(Array.from(decodeBase64URL(''))).toEqual([])
  })
})

describe('toCreationOptions', () => {
  it('превращает challenge, user.id и excludeCredentials в байты', () => {
    const options = toCreationOptions({
      rp: { id: 'fraze.skynas.ru', name: 'SkyFraze' },
      user: { id: 'AQID', name: 'me@example.com', displayName: 'Автор' },
      challenge: 'AQID',
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [{ type: 'public-key', id: 'AQID', transports: ['internal'] }],
      attestation: 'none',
    })
    expect(Array.from(options.challenge as Uint8Array)).toEqual([1, 2, 3])
    expect(Array.from(options.user.id as Uint8Array)).toEqual([1, 2, 3])
    expect(Array.from(options.excludeCredentials![0].id as Uint8Array)).toEqual([1, 2, 3])
    expect(options.rp.name).toBe('SkyFraze')
    // Ключи-исключения обязаны быть типа public-key: браузер иначе не поймёт список.
    expect(options.excludeCredentials![0].type).toBe('public-key')
  })

  it('без excludeCredentials не выдумывает пустой список с мусором', () => {
    const options = toCreationOptions({
      rp: { name: 'SkyFraze' },
      user: { id: 'AQID', name: 'me', displayName: 'Я' },
      challenge: 'AQID',
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    })
    expect(options.excludeCredentials).toEqual([])
    expect(options.attestation).toBe('none')
  })
})

describe('toRequestOptions', () => {
  it('разбирает allowCredentials и userVerification', () => {
    const options = toRequestOptions({
      challenge: 'AQID',
      allowCredentials: [{ type: 'public-key', id: 'AQID', transports: ['internal'] }],
      userVerification: 'preferred',
    })
    expect(Array.from(options.challenge as Uint8Array)).toEqual([1, 2, 3])
    expect(Array.from(options.allowCredentials![0].id as Uint8Array)).toEqual([1, 2, 3])
    expect(options.userVerification).toBe('preferred')
  })
})

describe('тело ответа аутентификатора', () => {
  const cred = (response: Record<string, unknown>) =>
    ({
      id: 'cred-id',
      rawId: new Uint8Array([1, 2, 3]).buffer,
      type: 'public-key',
      response,
    }) as unknown as PublicKeyCredential

  it('привязка: clientDataJSON и attestationObject в base64url', () => {
    const body = registrationBody(
      cred({
        clientDataJSON: new Uint8Array([4, 5]).buffer,
        attestationObject: new Uint8Array([6, 7, 8]).buffer,
      }),
    )
    expect(body.id).toBe('cred-id')
    expect(body.rawId).toBe('AQID')
    expect(body.type).toBe('public-key')
    expect(body.response).toEqual({ clientDataJSON: 'BAU', attestationObject: 'BgcI' })
  })

  it('вход: подпись, authenticatorData и пустой userHandle как null', () => {
    const body = assertionBody(
      cred({
        clientDataJSON: new Uint8Array([4]).buffer,
        authenticatorData: new Uint8Array([5]).buffer,
        signature: new Uint8Array([6]).buffer,
        userHandle: null,
      }),
    )
    expect(body.response).toEqual({
      clientDataJSON: 'BA',
      authenticatorData: 'BQ',
      signature: 'Bg',
      userHandle: null,
    })
  })
})

describe('passkeysSupported', () => {
  it('в окружении без WebAuthn отвечает «нет», а не падает', () => {
    // jsdom не умеет WebAuthn: это и есть проверяемый случай — раздел должен сказать об этом
    // словами, а не уронить профиль.
    expect(passkeysSupported()).toBe(false)
  })
})
