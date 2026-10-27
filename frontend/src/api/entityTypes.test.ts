import { describe, expect, it, vi } from 'vitest'
import type { EntityType } from './entityTypes'
import { typeTitle, typeColor } from './entityTypes'

/**
 * Типы карточек (0.81.0): подпись вида и цвет по проекту.
 *
 * Ключевое правило: неизвестный ключ показывается КАК ЕСТЬ, а не «Персонажем». Подставлять
 * дефолтную подпись — значит врать о данных: у человека в проекте может быть «Фракция», и
 * назвать её персонажем хуже, чем показать машинный ключ.
 */

const type = (over: Partial<EntityType>): EntityType => ({
  key: 'character',
  title: 'Персонаж',
  color: '',
  icon: '',
  position: 0,
  is_default: true,
  created_at: '',
  ...over,
})

describe('typeTitle', () => {
  it('берёт название из типов проекта', () => {
    const types = [type({}), type({ key: 'frakciya', title: 'Фракция', is_default: false })]
    expect(typeTitle(types, 'frakciya')).toBe('Фракция')
    expect(typeTitle(types, 'character')).toBe('Персонаж')
  })

  it('переименованный стартовый тип показывается новым названием', () => {
    expect(typeTitle([type({ title: 'Герой' })], 'character')).toBe('Герой')
  })

  it('пока типы не приехали — стартовые подписи', () => {
    expect(typeTitle([], 'place')).toBe('Место')
    expect(typeTitle([], 'theme')).toBe('Тема')
  })

  it('неизвестный ключ показывается как есть, а не «Персонажем»', () => {
    expect(typeTitle([], 'dragon')).toBe('dragon')
    expect(typeTitle([], '')).toBe('')
  })
})

describe('typeColor', () => {
  it('цвет типа — для подсветки, если у карточки свой не задан', () => {
    const types = [type({ key: 'frakciya', color: '#88aa66', is_default: false })]
    expect(typeColor(types, 'frakciya')).toBe('#88aa66')
    expect(typeColor(types, 'unknown')).toBe('')
  })
})

describe('listEntityTypes разбор', () => {
  it('битые записи пропускаются, поля приводятся к виду', async () => {
    vi.resetModules()
    const http = { get: vi.fn() }
    vi.doMock('./client', () => ({ http }))
    http.get.mockReturnValue({
      json: async () => ({
        types: [
          { key: 'frakciya', title: 'Фракция', position: 3, is_default: false },
          { title: 'Без ключа' },
          null,
        ],
      }),
    })
    const { listEntityTypes } = await import('./entityTypes')
    const list = await listEntityTypes('p1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ key: 'frakciya', title: 'Фракция', position: 3, color: '' })
    vi.doUnmock('./client')
  })
})
