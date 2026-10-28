import { describe, expect, it } from 'vitest'
import { buildEntityIndex, normalizeForSearch, searchEntities } from './entitySearch'
import type { EntityLink, ProjectEntity } from '../api/entities'
import type { EntityType } from '../api/entityTypes'

/**
 * Поиск по меткам карточки (0.100.0).
 *
 * Отчёт: «поиск должен выдавать подсказками совпадающие проиндексированные метки из карточек».
 * До этого граф искал только по имени: алиасы, вид и подписи связей не участвовали, и «Анна» не
 * находила «Аню».
 */

const entity = (over: Partial<ProjectEntity>): ProjectEntity => ({
  id: 'e1',
  kind: 'character',
  name: 'Анна',
  aliases: [],
  description: '',
  color: '',
  created_at: '2026-10-27T09:00:00Z',
  updated_at: '2026-10-27T09:00:00Z',
  ...over,
})

const link = (over: Partial<EntityLink>): EntityLink => ({
  id: 'l1',
  from_entity: 'e1',
  to_entity: 'e2',
  label: 'живёт на',
  created_at: '2026-10-27T10:00:00Z',
  ...over,
})

const types: EntityType[] = [
  { key: 'character', title: 'Персонаж', color: '', icon: '', position: 1, is_default: true, created_at: '' },
  { key: 'place', title: 'Место', color: '', icon: '', position: 2, is_default: true, created_at: '' },
]

describe('normalizeForSearch', () => {
  it('нижний регистр, ё → е, лишние пробелы схлопнуты', () => {
    expect(normalizeForSearch('  Дом  на  Холме ')).toBe('дом на холме')
    expect(normalizeForSearch('ЧЁРНОЕ солнце')).toBe('черное солнце')
  })
})

describe('searchEntities', () => {
  const anna = entity({ id: 'e1', name: 'Анна', aliases: ['Аня', 'Аннушка'] })
  const earth = entity({ id: 'e2', name: 'Земля', kind: 'place', aliases: [] })
  const index = buildEntityIndex([anna, earth], [link({})], types)

  it('находит по алиасу — раньше поиск его не видел', () => {
    const hits = searchEntities(index, 'аня')
    expect(hits).toHaveLength(1)
    expect(hits[0].entity.name).toBe('Анна')
    expect(hits[0].source).toBe('alias')
    expect(hits[0].matched).toBe('Аня')
  })

  it('находит по виду карточки', () => {
    const hits = searchEntities(index, 'место')
    expect(hits.map((hit) => hit.entity.name)).toEqual(['Земля'])
    expect(hits[0].source).toBe('kind')
  })

  it('находит по подписи связи — обе стороны связи', () => {
    const hits = searchEntities(index, 'живёт')
    expect(hits.map((hit) => hit.entity.name).sort()).toEqual(['Анна', 'Земля'])
    expect(hits[0].source).toBe('link')
  })

  it('имя весит больше алиаса: «ан» поднимает Анну, а не «Ангарск» из подписи', () => {
    const other = entity({ id: 'e3', name: 'Сторож', aliases: [] })
    const withLink = buildEntityIndex([anna, earth, other], [link({ label: 'живёт в Ангарске' })], types)
    const hits = searchEntities(withLink, 'ан')
    expect(hits[0].entity.name).toBe('Анна')
    expect(hits[0].source).toBe('name')
  })

  it('регистр и ё не мешают: «ЧЁРНОЕ» находится по «черное»', () => {
    const storm = entity({ id: 'e4', name: 'Чёрное солнце', aliases: [] })
    const local = buildEntityIndex([storm], [], types)
    expect(searchEntities(local, 'черное')).toHaveLength(1)
    expect(searchEntities(local, 'ЧЁРНОЕ')).toHaveLength(1)
  })

  it('пустой запрос — пустая выдача, а не весь список', () => {
    expect(searchEntities(index, '   ')).toEqual([])
  })

  it('предел выдачи соблюдается', () => {
    const many = Array.from({ length: 20 }, (_, i) => entity({ id: `x${i}`, name: `Аня ${i}` }))
    const local = buildEntityIndex(many, [], types)
    expect(searchEntities(local, 'аня', 5)).toHaveLength(5)
  })
})
