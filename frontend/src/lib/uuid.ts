/**
 * Генерация идентификаторов, работающая в любом контексте.
 *
 * `crypto.randomUUID()` доступен ТОЛЬКО в защищённом контексте (https или localhost).
 * Стенд, открытый по IP — `http://192.168.13.66` — таковым не является, поэтому на
 * телефоне этот вызов падал с `TypeError: crypto.randomUUID is not a function`, и
 * страница проекта превращалась в пустой экран. Здесь есть запасные пути:
 * `crypto.getRandomValues` (доступен всегда) и, на самый крайний случай, Math.random.
 */

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T
}

export function randomId(source: CryptoLike | undefined = globalThis.crypto as CryptoLike | undefined): string {
  if (source && typeof source.randomUUID === 'function') {
    return source.randomUUID()
  }

  if (source && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // версия 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // вариант RFC 4122
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Последний рубеж: идентификатор нужен для CRDT-узла, криптостойкость тут не нужна.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
