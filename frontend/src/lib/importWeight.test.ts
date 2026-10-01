import { describe, expect, it } from 'vitest'

import { importWeight } from './importWeight'

/**
 * Подпись о весе набора перед импортом.
 *
 * Зачем: импорт подчиняется пределу вложений проекта, и набор, который не
 * помещается, отклоняется на первом же файле. Раньше об этом узнавали из отказа
 * после импорта — теперь видно в предпросмотре.
 */
const mb = (n: number) => n * 1024 * 1024

describe('importWeight', () => {
  it('без вложений говорить нечего', () => {
    expect(importWeight({ attachments: 0, attachmentBytes: 0 }, mb(10))).toBeNull()
  })

  it('без предела показывает только вес', () => {
    const note = importWeight({ attachments: 3, attachmentBytes: mb(4) }, 0)
    expect(note).toEqual({ text: 'вложения: 3 · 4.0 МБ', warning: null })
  })

  it('набор, который помещается, — без предупреждения', () => {
    const note = importWeight({ attachments: 3, attachmentBytes: mb(2) }, mb(10))
    expect(note?.warning).toBeNull()
    expect(note?.text).toBe('вложения: 3 · 2.0 МБ')
  })

  it('набор больше предела (новый проект) — прямо говорим, что не поместится', () => {
    const note = importWeight({ attachments: 40, attachmentBytes: mb(24) }, mb(10))
    expect(note?.warning).toContain('не поместится')
    expect(note?.warning).toContain('10.0 МБ')
    expect(note?.warning).toContain('24.0 МБ')
  })

  it('импорт «в место» учитывает занятое место проекта', () => {
    const note = importWeight({ attachments: 4, attachmentBytes: mb(3) }, mb(10), mb(8))
    expect(note?.warning).toContain('занято 8.0 МБ из 10.0 МБ')
    expect(note?.warning).toContain('не поместится')
  })

  it('почти весь предел — предупреждаем мягко, но предупреждаем', () => {
    const note = importWeight({ attachments: 2, attachmentBytes: mb(1) }, mb(10), mb(7.5))
    expect(note?.warning).toContain('место почти закончится')
    expect(note?.warning).toContain('8.5 МБ из 10.0 МБ')
  })

  it('ровно в предел — предупреждаем, что предел будет занят целиком', () => {
    const note = importWeight({ attachments: 2, attachmentBytes: mb(2) }, mb(10), mb(8))
    expect(note?.warning).toContain('предел будет занят целиком')
  })

  it('чуть меньше предела (82%) — мягкое предупреждение', () => {
    const note = importWeight({ attachments: 1, attachmentBytes: mb(0.5) }, mb(10), mb(7.7))
    expect(note?.warning).toContain('место почти закончится')
  })
})
