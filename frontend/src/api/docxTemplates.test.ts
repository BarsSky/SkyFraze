import { describe, expect, it } from 'vitest'
import { DOX_MAPPING_LABELS, mappingRows, type DocxReport } from './docxTemplates'

/**
 * Отчёт шаблона DOCX (0.91.0): разбор ответа сервера и подписи карты стилей.
 *
 * Интерфейс показывает человеку не «сырой JSON», а строки «что в проекте → какой стиль шаблона»
 * и предупреждения; поэтому проверяем, что неизвестный ключ не теряется и не превращается в
 * пустую строку.
 */

const report = (over: Partial<DocxReport> = {}): DocxReport => ({
  has_placeholder: true,
  has_numbering: false,
  styles: [],
  mapping: {},
  warnings: [],
  page: {},
  ...over,
})

describe('mappingRows — карта стилей для человека', () => {
  it('известные ключи получают русские подписи', () => {
    const rows = mappingRows(report({ mapping: { heading1: 'Heading1', body: 'Normal' } }))
    expect(rows).toEqual([
      { key: 'heading1', label: 'главы', style: 'Heading1' },
      { key: 'body', label: 'обычный текст', style: 'Normal' },
    ])
  })

  it('неизвестный ключ не теряется и показывается как есть', () => {
    const rows = mappingRows(report({ mapping: { footnote: 'FootnoteText' } }))
    expect(rows[0]).toEqual({ key: 'footnote', label: 'footnote', style: 'FootnoteText' })
    expect(DOX_MAPPING_LABELS.heading2).toBe('под-события')
  })
})
