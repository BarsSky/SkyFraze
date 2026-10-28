/**
 * Служебный кадр чата в сокете документа (0.96.0).
 *
 * Тот же сокет, что носит CRDT и присутствие, носит и сигнал «в проекте появилось сообщение».
 * Кадр без содержимого: клиент по нему спрашивает «что нового» обычным запросом, поэтому текст
 * сообщения не дублируется в канале доставки.
 *
 * Префикс проверяется ДО разбора: всё, что не начинается с него, — либо присутствие (`sfp1:`),
 * либо обычный апдейт Yjs, и разбирать его как чат нельзя.
 */
export const CHAT_NOTIFY_PREFIX = 'sfc1:'
const PREFIX_BYTES = new TextEncoder().encode(CHAT_NOTIFY_PREFIX)

/** Тот же кадр пришёл строкой или байтами — оба вида сокет может доставить. */
export function isChatNotify(data: string | Uint8Array): boolean {
  if (typeof data === 'string') return data.startsWith(CHAT_NOTIFY_PREFIX)
  if (data.byteLength < PREFIX_BYTES.length) return false
  for (let i = 0; i < PREFIX_BYTES.length; i += 1) {
    if (data[i] !== PREFIX_BYTES[i]) return false
  }
  return true
}
