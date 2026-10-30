import { describe, expect, it } from 'vitest'
import { promptHints } from './promptHints'

/**
 * Подсказки в пустом чате.
 *
 * Проверяем не «список непустой», а два правила, ради которых они и сделаны: подсказки
 * зависят от роли агента (летописцу — хронология, фантасту — детали мира) и первая из них
 * зависит от состояния проекта (пустой — «собери с нуля», непустой — «продолжи»).
 */
describe('promptHints', () => {
  it('в пустом проекте предлагает собрать проект с нуля', () => {
    const hints = promptHints('', true)
    expect(hints.length).toBeGreaterThan(0)
    expect(hints[0].label).toMatch(/с нуля/i)
    expect(hints[0].prompt).toMatch(/главы/i)
  })

  it('в непустом проекте первая подсказка — продолжение', () => {
    const hints = promptHints('', false)
    expect(hints[0].label).toMatch(/продолжи/i)
  })

  it('роль меняет подсказки, а не только их порядок', () => {
    const chronicler = promptHints('chronicler', false)
    const coauthor = promptHints('coauthor', false)
    expect(chronicler.map((h) => h.label)).not.toEqual(coauthor.map((h) => h.label))
    expect(chronicler.some((h) => /хронологи/i.test(h.label + h.prompt))).toBe(true)
    expect(coauthor.some((h) => /мир|поворот/i.test(h.label + h.prompt))).toBe(true)
  })

  it('у каждой подсказки есть и подпись, и текст для поля ввода', () => {
    for (const role of ['', 'chronicler', 'editor', 'coauthor', 'architect', 'неизвестная']) {
      for (const hint of promptHints(role, true)) {
        expect(hint.label.trim()).not.toBe('')
        expect(hint.prompt.trim().length).toBeGreaterThan(20)
      }
    }
  })

  /**
   * 0.125.0: подсказки — из словаря, язык третьим аргументом (по умолчанию русский, поэтому
   * проверки выше не тронуты). Подсказка уходит модели как текст запроса, поэтому на английском
   * интерфейсе и запрос английский — иначе модель получила бы русскую формулировку в английском
   * чате.
   */
  it('на английском подсказки и промпты переведены', () => {
    const hints = promptHints('', true, 'en')
    expect(hints[0].label).toBe('Build the project from scratch')
    expect(hints[0].prompt).toMatch(/three chapters/)

    const chronicler = promptHints('chronicler', false, 'en')
    expect(chronicler[0].label).toBe('Continue the story')
    expect(chronicler.map((hint) => hint.label)).toContain('Sort out the chronology')
    // Ни одной кириллической буквы: подсказка целиком на языке интерфейса.
    for (const hint of promptHints('coauthor', true, 'en')) {
      expect(hint.label + hint.prompt).not.toMatch(/[А-Яа-яЁё]/)
    }
  })

})
