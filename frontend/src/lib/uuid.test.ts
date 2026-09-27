import { describe, expect, it } from 'vitest'
import { randomId } from './uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('randomId', () => {
  it('использует crypto.randomUUID, когда он доступен (https/localhost)', () => {
    const id = randomId({ randomUUID: () => '11111111-2222-4333-8444-555555555555' })
    expect(id).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('работает без randomUUID — случай телефона на http://IP', () => {
    // Именно так ведёт себя Crypto в незащищённом контексте: randomUUID нет,
    // getRandomValues есть.
    const id = randomId({ getRandomValues: (arr) => arr })
    expect(id).toMatch(UUID_RE)
  })

  it('работает, когда нет ни randomUUID, ни getRandomValues', () => {
    const id = randomId(undefined)
    expect(id).toMatch(UUID_RE)
  })

  it('выдаёт разные id', () => {
    const a = randomId({ getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr) })
    const b = randomId({ getRandomValues: (arr) => globalThis.crypto.getRandomValues(arr) })
    expect(a).not.toBe(b)
    expect(a).toMatch(UUID_RE)
  })
})
