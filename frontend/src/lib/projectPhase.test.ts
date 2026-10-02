import { describe, expect, it } from 'vitest'
import { projectPhase } from './projectPhase'

/**
 * Фаза страницы проекта: загрузка, отказ или содержимое.
 *
 * Проверяем ровно то, на чём ломается интерфейс: пустой документ ДО загрузки не должен
 * выглядеть как пустой проект, а «прочитать не удалось» — как «проект пуст».
 */
describe('projectPhase', () => {
  it('пока контент не загружен, показывает загрузку, а не пустой проект', () => {
    expect(projectPhase({ projectKnown: true, content: 'loading', eventsCount: 0 })).toBe('loading')
  })

  it('пока роль неизвестна, тоже загрузка: в пустом проекте читателю и редактору видно разное', () => {
    expect(projectPhase({ projectKnown: false, content: 'ready', eventsCount: 0 })).toBe('loading')
  })

  it('отказ чтения — не пустой проект', () => {
    expect(projectPhase({ projectKnown: true, content: 'failed', eventsCount: 0 })).toBe('failed')
  })

  it('загружено и пусто — содержимое (дальше страница решает по роли)', () => {
    expect(projectPhase({ projectKnown: true, content: 'ready', eventsCount: 0 })).toBe('ready')
    expect(projectPhase({ projectKnown: true, content: 'ready', eventsCount: 3 })).toBe('ready')
  })

  it('документа ещё нет — загрузка, даже если контент «готов»', () => {
    expect(projectPhase({ projectKnown: true, content: 'ready', eventsCount: -1 })).toBe('loading')
  })

  it('ошибку загрузки проекта показывает баннер, фаза не мешает', () => {
    expect(projectPhase({ projectKnown: false, content: 'loading', eventsCount: -1, failed: true })).toBe(
      'ready',
    )
  })
})
