import { describe, expect, it } from 'vitest'
import { CRAFT_CATALOG, craftShort, craftsOf } from './crafts'

describe('каталог специализаций', () => {
  it('покрывает виды творческой работы, о которых просили', () => {
    const all = CRAFT_CATALOG.join(' | ')
    for (const нужное of [
      'Правописание',
      'Проработка героя',
      'Проработка злодея',
      'Роли персонажей',
      'Технические концепты',
      'Магические системы',
      'Ландшафты',
      'Иллюстрации',
    ]) {
      expect(all).toContain(нужное)
    }
  })

  it('не содержит дублей и пустых подсказок', () => {
    const normalized = CRAFT_CATALOG.map((c) => c.trim().toLowerCase())
    expect(new Set(normalized).size).toBe(CRAFT_CATALOG.length)
    expect(normalized.every((c) => c.length > 0)).toBe(true)
  })
})

describe('craftsOf', () => {
  it('null и undefined превращает в пустой список', () => {
    expect(craftsOf(null)).toEqual([])
    expect(craftsOf(undefined)).toEqual([])
    expect(craftsOf(['Арт'])).toEqual(['Арт'])
  })
})

describe('craftShort', () => {
  it('сокращает длинные формулировки до сути', () => {
    expect(craftShort('Правописание и корректура')).toBe('Правописание')
    expect(craftShort('Ландшафты и мир')).toBe('Ландшафты')
  })

  it('оставляет короткую формулировку как есть', () => {
    expect(craftShort('Диалоги')).toBe('Диалоги')
    expect(craftShort('')).toBe('')
  })
})
