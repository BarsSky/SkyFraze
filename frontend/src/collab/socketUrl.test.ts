import { describe, expect, it } from 'vitest'
import { collabSocketUrl } from './socketUrl'

describe('collabSocketUrl', () => {
  it('на HTTPS-странице даёт wss (иначе браузер бросает SecurityError)', () => {
    expect(collabSocketUrl('p1', { protocol: 'https:', host: 'fraza.skynas.ru' })).toBe(
      'wss://fraza.skynas.ru/api/projects/p1/collab',
    )
  })

  it('на HTTP-странице остаётся ws', () => {
    expect(collabSocketUrl('p1', { protocol: 'http:', host: '192.168.13.66' })).toBe(
      'ws://192.168.13.66/api/projects/p1/collab',
    )
  })

  it('localhost по HTTP — ws', () => {
    expect(collabSocketUrl('abc', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/projects/abc/collab',
    )
  })

  it('экранирует идентификатор проекта', () => {
    expect(collabSocketUrl('a b', { protocol: 'https:', host: 'h' })).toContain('/api/projects/a%20b/collab')
  })
})
