import { describe, expect, it, vi } from 'vitest'
import { graphViewKey, readGraphView, writeGraphView, type StorageLike } from './graphView'

/**
 * Запомненный уровень графа (0.101.0).
 *
 * Решение из отчёта: «запоминать раскрытый уровень». Проверяем и защиту: битые данные и занятая
 * квота не должны ронять страницу — уровень это удобство, а не данные проекта.
 */

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

describe('graphView', () => {
  it('сохраняет и читает уровень с группой', () => {
    const storage = memory()
    writeGraphView('p1', { level: 'world', groupKind: 'character' }, storage)
    expect(readGraphView('p1', storage)).toEqual({ level: 'world', groupKind: 'character' })
  })

  it('без запомненного — null, а не «мир по умолчанию»', () => {
    expect(readGraphView('p2', memory())).toBeNull()
  })

  it('битые данные не ломают страницу', () => {
    const storage = memory()
    storage.setItem(graphViewKey('p3'), '{это не json')
    expect(readGraphView('p3', storage)).toBeNull()
    storage.setItem(graphViewKey('p3'), JSON.stringify({ level: 'небо' }))
    expect(readGraphView('p3', storage)).toBeNull()
  })

  it('переполненная квота при записи не бросает наружу', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded')
      },
    }
    expect(() => writeGraphView('p4', { level: 'world', groupKind: null }, storage)).not.toThrow()
  })

  it('без projectId ничего не пишет и не читает', () => {
    const storage = memory()
    writeGraphView('', { level: 'world', groupKind: null }, storage)
    expect(storage.data.size).toBe(0)
    expect(readGraphView('', storage)).toBeNull()
  })

  it('видна в localStorage по ключу проекта — им пользуются между заходами', () => {
    const storage = memory()
    const spy = vi.spyOn(storage, 'setItem')
    writeGraphView('p5', { level: 'card', groupKind: null }, storage)
    expect(spy).toHaveBeenCalledWith(graphViewKey('p5'), JSON.stringify({ level: 'card', groupKind: '' }))
  })
})
