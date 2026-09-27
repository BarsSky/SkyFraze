import { describe, expect, it } from 'vitest'
import { formatDate, formatRating, formatViews, plural } from './format'

describe('plural', () => {
  it('склоняет по русским правилам', () => {
    expect(plural(1, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотр')
    expect(plural(2, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотра')
    expect(plural(4, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотра')
    expect(plural(5, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотров')
    expect(plural(11, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотров')
    expect(plural(21, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотр')
    expect(plural(102, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотра')
    expect(plural(111, 'просмотр', 'просмотра', 'просмотров')).toBe('просмотров')
  })
})

describe('formatViews', () => {
  it('не показывает «0 просмотров» и согласует число', () => {
    expect(formatViews(0)).toBe('нет просмотров')
    expect(formatViews(1)).toBe('1 просмотр')
    expect(formatViews(3)).toBe('3 просмотра')
    expect(formatViews(11)).toBe('11 просмотров')
  })
})

describe('formatRating', () => {
  it('без оценок не выдумывает среднее', () => {
    expect(formatRating(0, 0)).toBe('нет оценок')
  })
  it('показывает среднее с одним знаком и число оценок', () => {
    expect(formatRating(5, 1)).toBe('5.0 · 1 оценка')
    expect(formatRating(3.5, 2)).toBe('3.5 · 2 оценки')
    expect(formatRating(4.25, 12)).toBe('4.3 · 12 оценок')
  })
})

describe('formatDate', () => {
  it('форматирует ISO и терпит пустое значение', () => {
    expect(formatDate('2026-09-27T15:00:00Z')).toMatch(/^2[67]\.09\.2026$/)
    expect(formatDate(null)).toBe('')
    expect(formatDate('мусор')).toBe('')
  })
})
