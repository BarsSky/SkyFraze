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
})
