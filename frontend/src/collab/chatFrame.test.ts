import { describe, expect, it } from 'vitest'
import { CHAT_NOTIFY_PREFIX, isChatNotify } from './chatFrame'

/**
 * Служебный кадр чата (0.96.0).
 *
 * Сокет документа носит три вида кадров: CRDT-апдейты (бинарные), присутствие (`sfp1:`) и сигнал
 * чата (`sfc1:`). Ошибка распознавания стоит дорого: CRDT-кадр, принятый за чат, отбросил бы
 * правку текста, а сигнал чата, отданный в Yjs, сломал бы разбор документа. Поэтому проверяем
 * обе стороны: свой префикс распознаётся, чужие — нет.
 */

describe('isChatNotify', () => {
  it('распознаёт свой префикс строкой и байтами', () => {
    expect(isChatNotify(`${CHAT_NOTIFY_PREFIX}`)).toBe(true)
    expect(isChatNotify(new TextEncoder().encode(CHAT_NOTIFY_PREFIX))).toBe(true)
  })

  it('присутствие и CRDT-апдейт не считает сигналом чата', () => {
    expect(isChatNotify('sfp1:{"peers":[]}')).toBe(false)
    expect(isChatNotify(new TextEncoder().encode('sfp1:01:{'))).toBe(false)
    // Типичное начало Yjs-апдейта: байты структуры, а не текст.
    expect(isChatNotify(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe(false)
    expect(isChatNotify(new Uint8Array([115, 102, 99]))).toBe(false) // «sfc» — без двоеточия и «1»
  })

  it('короткий кадр не ломает проверку', () => {
    expect(isChatNotify(new Uint8Array([]))).toBe(false)
    expect(isChatNotify('')).toBe(false)
  })
})
