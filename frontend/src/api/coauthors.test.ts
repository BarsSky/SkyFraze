import { describe, expect, it } from 'vitest'
import { normalizeUsername, validUsername } from './coauthors'

describe('normalizeUsername', () => {
  it('приводит ник к каноническому виду', () => {
    expect(normalizeUsername('Anna')).toBe('anna')
    expect(normalizeUsername('@Anna.Design')).toBe('anna.design')
    expect(normalizeUsername('  @anna  ')).toBe('anna')
    expect(normalizeUsername('anna_design-2')).toBe('anna_design-2')
  })

  it('выбрасывает недопустимые символы, а не молча ломает ник', () => {
    // Кириллица не входит в набор: ник вводится латиницей, иначе его не набрать
    // на чужой клавиатуре.
    expect(normalizeUsername('аня')).toBe('')
    expect(normalizeUsername('anna!')).toBe('anna')
    expect(normalizeUsername('a b c')).toBe('abc')
  })

  it('обрезает до 32 символов', () => {
    expect(normalizeUsername('a'.repeat(40))).toHaveLength(32)
  })
})

describe('validUsername', () => {
  it('принимает ник от 3 до 32 символов', () => {
    expect(validUsername('anna')).toBe(true)
    expect(validUsername('@anna.design')).toBe(true)
    expect(validUsername('a'.repeat(32))).toBe(true)
  })

  it('отклоняет короткий, пустой и нелатинский ник', () => {
    expect(validUsername('an')).toBe(false)
    expect(validUsername('')).toBe(false)
    expect(validUsername('@')).toBe(false)
    expect(validUsername('аня')).toBe(false)
    expect(validUsername('a'.repeat(33))).toBe(false)
  })
})
