import { describe, expect, it } from 'vitest'

import {
  ACK_PREFIX,
  createAckTracker,
  encodeUpdateFrame,
  isAckFrame,
  parseAckFrame,
} from './ack'

/**
 * ack.test.ts — кадр правки и подтверждение (0.140.0).
 *
 * Формат общий с сервером (`backend/internal/collab/ack.go`), поэтому проверяется он, а не
 * транспорт: номер обязан пережить круг «отправил → сервер вернул», чужой кадр не должен
 * считаться подтверждением, а учёт ожиданий — не терять и не копить лишнего.
 */

const bytes = (...values: number[]) => new Uint8Array(values)

describe('ack.encodeUpdateFrame', () => {
  it('склеивает префикс, номер и апдейт', () => {
    const frame = encodeUpdateFrame(10, bytes(1, 2, 3))
    expect(new TextDecoder().decode(frame.subarray(0, 5))).toBe('sfu1:')
    expect(new TextDecoder().decode(frame.subarray(5, 13))).toBe('0000000a')
    expect([...frame.subarray(13)]).toEqual([1, 2, 3])
  })

  it('держит номер в 32 битах', () => {
    const frame = encodeUpdateFrame(0x1_0000_0000, bytes(1))
    expect(new TextDecoder().decode(frame.subarray(5, 13))).toBe('00000000')
    const last = encodeUpdateFrame(0xff_ffff, bytes(1))
    expect(new TextDecoder().decode(last.subarray(5, 13))).toBe('00ffffff')
  })

  it('не путает кадр правки с подтверждением', () => {
    expect(isAckFrame(encodeUpdateFrame(1, bytes(1)))).toBe(false)
  })
})

describe('ack.parseAckFrame', () => {
  it('вынимает номер', () => {
    const frame = new TextEncoder().encode(`${ACK_PREFIX}0000002a`)
    expect(parseAckFrame(frame)).toBe(42)
    expect(isAckFrame(frame)).toBe(true)
  })

  it('возвращает null на чужом кадре', () => {
    expect(parseAckFrame(encodeUpdateFrame(1, bytes(9, 9)))).toBeNull()
    expect(parseAckFrame(bytes(0, 1, 2))).toBeNull()
    expect(parseAckFrame(new TextEncoder().encode(`${ACK_PREFIX}0000`))).toBeNull()
  })

  it('не подтверждает нечитаемый номер', () => {
    // Такой кадр сервер прислать не может, а «подтвердить» им нечего.
    expect(parseAckFrame(new TextEncoder().encode(`${ACK_PREFIX}zzzzzzzz`))).toBeNull()
  })
})

describe('ack.createAckTracker', () => {
  it('считает подтверждённые и ждёт остальные', () => {
    const tracker = createAckTracker()
    const first = tracker.nextID()
    const second = tracker.nextID()
    expect(first).not.toBe(second)
    tracker.sent(first)
    tracker.sent(second)
    expect(tracker.size()).toBe(2)

    expect(tracker.confirm(first)).toBe(false)
    expect(tracker.size()).toBe(1)
    expect(tracker.confirmed()).toBe(1)
    // Последнее подтверждение — сигнал «можно не писать снапшот по REST».
    expect(tracker.confirm(second)).toBe(true)
    expect(tracker.size()).toBe(0)
    expect(tracker.confirmed()).toBe(2)
  })

  it('не считает подтверждением чужой номер', () => {
    const tracker = createAckTracker()
    tracker.sent(tracker.nextID())
    expect(tracker.confirm(999)).toBe(false)
    expect(tracker.size()).toBe(1)
    expect(tracker.confirmed()).toBe(0)
  })

  it('забывает ожидания по clear и forget', () => {
    const tracker = createAckTracker()
    const a = tracker.nextID()
    const b = tracker.nextID()
    tracker.sent(a)
    tracker.sent(b)
    tracker.forget(a)
    expect(tracker.size()).toBe(1)
    tracker.clear()
    expect(tracker.size()).toBe(0)
  })

  it('не копит ожидания сверх предела', () => {
    const tracker = createAckTracker(3)
    for (let i = 0; i < 10; i += 1) tracker.sent(tracker.nextID())
    expect(tracker.size()).toBe(3)
  })
})
