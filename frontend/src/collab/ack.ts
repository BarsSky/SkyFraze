/**
 * ack.ts — подтверждение приёма правки сервером (0.140.0).
 *
 * Зачем. До 0.140.0 единственным доказательством «сервер получил» был `readyState === OPEN`, а он
 * врёт: прокси без `Upgrade` и полуоткрытое соединение тоже показывают `OPEN`. Поэтому клиент
 * писал состояние по REST раз в 10 секунд тишины — с окном потери до 10 секунд и лишним PUT на
 * каждые 10 секунд печати. Теперь сервер отвечает на каждый апдейт: «вот твой номер, эти байты уже
 * в документе комнаты». Пока подтверждения приходят, писать по REST не нужно.
 *
 * Формат (проводной контракт с `backend/internal/collab/ack.go`):
 *   - правка: ASCII-префикс `sfu1:`, номер из 8 ASCII-байт (нижний регистр hex), Yjs-апдейт;
 *   - подтверждение: `sfa1:` и те же 8 байт.
 * Номер — свой счётчик клиента: сервер его не разбирает, а возвращает как есть, поэтому формат
 * номера можно менять, не трогая сервер.
 *
 * Почему префикс, а не байт типа. Так же устроены присутствие (`sfp1:`) и сигнал чата (`sfc1:`).
 * Старый клиент, который шлёт голые апдейты, продолжает работать — сервер принимает и их.
 */

/** UPDATE_PREFIX — начало кадра правки (клиент → сервер). */
export const UPDATE_PREFIX = 'sfu1:'
/** ACK_PREFIX — начало кадра подтверждения (сервер → клиент). */
export const ACK_PREFIX = 'sfa1:'

/** ID_BYTES — длина номера правки: 8 hex-байт покрывают 2^32 апдейтов за сессию. */
const ID_BYTES = 8
/** MAX_ID — предел номера: счётчик обязан оставаться в пределах 32 бит. */
const MAX_ID = 0x1_0000_0000
/** MAX_PENDING — сколько номеров ждём одновременно. */
const MAX_PENDING = 512

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const UPDATE_PREFIX_BYTES = ENCODER.encode(UPDATE_PREFIX)
const ACK_PREFIX_BYTES = ENCODER.encode(ACK_PREFIX)

/** encodeUpdateFrame — кадр правки: префикс, номер и сам апдейт. */
export function encodeUpdateFrame(id: number, update: Uint8Array): Uint8Array {
  const frame = new Uint8Array(UPDATE_PREFIX_BYTES.byteLength + ID_BYTES + update.byteLength)
  frame.set(UPDATE_PREFIX_BYTES, 0)
  frame.set(idBytes(id), UPDATE_PREFIX_BYTES.byteLength)
  frame.set(update, UPDATE_PREFIX_BYTES.byteLength + ID_BYTES)
  return frame
}

/** isAckFrame — этот кадр похож на подтверждение (без разбора номера). */
export function isAckFrame(data: Uint8Array): boolean {
  if (data.byteLength < ACK_PREFIX_BYTES.byteLength + ID_BYTES) return false
  for (let i = 0; i < ACK_PREFIX_BYTES.byteLength; i += 1) {
    if (data[i] !== ACK_PREFIX_BYTES[i]) return false
  }
  return true
}

/**
 * parseAckFrame — номер из кадра подтверждения, `null` — это не подтверждение или кадр обрезан.
 *
 * Неподтверждаемый номер (не hex) тоже `null`: такой кадр сервер прислать не может, а
 * «подтвердить» им нечего.
 */
export function parseAckFrame(data: Uint8Array): number | null {
  if (!isAckFrame(data)) return null
  const text = DECODER.decode(data.subarray(ACK_PREFIX_BYTES.byteLength, ACK_PREFIX_BYTES.byteLength + ID_BYTES))
  if (!/^[0-9a-f]{8}$/.test(text)) return null
  return Number.parseInt(text, 16)
}

/** idBytes — номер в 8 hex-байт, ровно того же вида, что ждёт сервер. */
function idBytes(id: number): Uint8Array {
  const text = (id % MAX_ID).toString(16).padStart(ID_BYTES, '0')
  return ENCODER.encode(text)
}

/**
 * Учёт отправленных, но не подтверждённых правок.
 *
 * Отдельный тип, а не поля в провайдере, потому что именно эта арифметика решает, писать ли
 * состояние по REST: «нет ожидающих подтверждения» = серверу верить можно. Ошибка здесь стоит
 * либо лишних PUT на каждой букве, либо пропавшей правки, поэтому она проверяется юнит-тестами.
 */
export type AckTracker = {
  /** nextID — номер для следующего кадра. */
  nextID(): number
  /** sent — запомнить отправленный номер. */
  sent(id: number): void
  /** confirm — отметить подтверждение; `true` — неподтверждённых больше нет. */
  confirm(id: number): boolean
  /** forget — номер больше не ждём (сокет закрылся, состояние записано по REST). */
  forget(id: number): void
  /** clear — забыть все ожидания. */
  clear(): void
  /** size — сколько номеров ждут подтверждения. */
  size(): number
  /** confirmed — сколько подтверждений пришло за сессию (диагностика и e2e). */
  confirmed(): number
}

export function createAckTracker(limit = MAX_PENDING): AckTracker {
  /** Порядок вставки — порядок отправки: самый старый номер забываем первым. */
  const pending = new Map<number, true>()
  let seq = 0
  let confirmedTotal = 0
  return {
    nextID() {
      seq = (seq + 1) % MAX_ID
      return seq
    },
    sent(id: number) {
      pending.set(id, true)
      // Предел — не «на всякий случай»: если подтверждения не приходят вовсе, множество росло бы
      // с каждой буквой до конца сессии. Старые номера забываем, правда о них уже не нужна:
      // состояние подтвердит запись по REST.
      while (pending.size > limit) {
        const oldest = pending.keys().next()
        if (oldest.done) break
        pending.delete(oldest.value)
      }
    },
    confirm(id: number) {
      if (!pending.delete(id)) return false
      confirmedTotal += 1
      return pending.size === 0
    },
    forget(id: number) {
      pending.delete(id)
    },
    clear() {
      pending.clear()
    },
    size() {
      return pending.size
    },
    confirmed() {
      return confirmedTotal
    },
  }
}
