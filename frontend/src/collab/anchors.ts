import * as Y from 'yjs'

/**
 * Якоря замечаний к фрагменту текста.
 *
 * Зачем отдельный модуль. Замечание ставится к двум строкам, а текст живёт в CRDT: вставка
 * абзаца выше сдвигает все смещения, и замечание молча переезжает на другой текст, оставаясь
 * «валидным» по форме. Поэтому позиция — не номер символа, а `Y.RelativePosition`: она
 * привязана к конкретным символам и переживает чужие правки
 * (docs/fragment-comments.md §4, там же измерения).
 *
 * Почему якорь создаёт клиент, а не сервер. Индексы Yjs — единицы UTF-16, и в браузере они
 * совпадают с индексами JS-строки по определению: выделение в `textarea` даёт ровно то, что
 * нужно, без конвертаций. Сервер видит снапшот, который отстаёт до ~5 секунд, поэтому создаёт
 * якорь тот, кто видит живой документ.
 */

/** Якорь в том виде, в каком он ходит по HTTP: позиции — base64 от `Y.encodeRelativePosition`. */
export interface FrameAnchor {
  field: string
  start: string
  end: string
  quote: string
}

/** Куда якорь указывает в текущем документе. */
export interface AnchorRange {
  from: number
  to: number
}

/**
 * Статус якоря:
 *   * `ok` — фрагмент на месте;
 *   * `collapsed` — позиции сошлись (фрагмент удалён или стал пустым);
 *   * `orphan` — резолв не удался (кадр переписан целиком или удалён).
 *
 * Статус не хранится в базе: он зависит от текущего документа и меняется после каждой чужой
 * правки. Считать его при чтении — единственный честный вариант.
 */
export type AnchorStatus = 'ok' | 'collapsed' | 'orphan'

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBytes(value: string): Uint8Array | null {
  if (!value) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Якорь на диапазон `[from, to)` в тексте.
 *
 * Ассоциации — как у выделения: начало «держится» за символом справа (`+1`), конец — за
 * символом слева (`−1`). Так вставка ровно на границе не расширяет фрагмент: чужой текст,
 * набранный встык, не становится частью замечания.
 */
export function encodeAnchor(
  text: Y.Text,
  from: number,
  to: number,
): { start: string; end: string; quote: string } | null {
  const content = text.toString()
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(content.length, Math.max(from, to))
  if (end <= start) return null
  try {
    const startPos = Y.createRelativePositionFromTypeIndex(text, start, 1)
    const endPos = Y.createRelativePositionFromTypeIndex(text, end, -1)
    return {
      start: encodeBytes(Y.encodeRelativePosition(startPos)),
      end: encodeBytes(Y.encodeRelativePosition(endPos)),
      quote: content.slice(start, end),
    }
  } catch {
    // Документ ещё не готов (текст не создан) — якоря нет, и это честнее мусора.
    return null
  }
}

/** Резолв якоря в текущем документе. null — фрагмент больше не находится. */
export function resolveAnchor(text: Y.Text, anchor: FrameAnchor): AnchorRange | null {
  const doc = text.doc
  if (!doc) return null
  const startBytes = decodeBytes(anchor.start)
  const endBytes = decodeBytes(anchor.end)
  if (!startBytes || !endBytes) return null
  try {
    const startPos = Y.decodeRelativePosition(startBytes)
    const endPos = Y.decodeRelativePosition(endBytes)
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startPos, doc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endPos, doc)
    if (!startAbs || !endAbs) return null
    // Якорь, указывающий в другое поле (или в другой кадр), — не наш: так выглядит
    // скопированный якорь или документ, собранный заново.
    if (startAbs.type !== text || endAbs.type !== text) return null
    const from = Math.min(startAbs.index, endAbs.index)
    const to = Math.max(startAbs.index, endAbs.index)
    return { from, to }
  } catch {
    return null
  }
}

/** Статус якоря: `ok` / `collapsed` / `orphan`. */
export function anchorStatus(text: Y.Text, anchor: FrameAnchor): AnchorStatus {
  const range = resolveAnchor(text, anchor)
  if (!range) return 'orphan'
  return range.to > range.from ? 'ok' : 'collapsed'
}

/** Текст фрагмента в текущем документе — для подсветки и для показа «что изменилось». */
export function anchorText(text: Y.Text, anchor: FrameAnchor): string {
  const range = resolveAnchor(text, anchor)
  if (!range) return ''
  return text.toString().slice(range.from, range.to)
}
