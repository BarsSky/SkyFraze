import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_KINDS,
  codeSkeleton,
  diagramSkeleton,
  formulaSkeleton,
  heading,
  insertBlock,
  prefixLines,
  tableSkeleton,
  wrapSelection,
} from './markdownInsert'

describe('wrapSelection', () => {
  it('оборачивает выделение', () => {
    const result = wrapSelection('колония АнуВаар', { start: 8, end: 15 }, '**')
    expect(result.text).toBe('колония **АнуВаар**')
    expect(result.text.slice(result.selection.start, result.selection.end)).toBe('АнуВаар')
  })

  it('без выделения ставит курсор внутрь маркеров', () => {
    const result = wrapSelection('текст', { start: 5, end: 5 }, '*')
    expect(result.text).toBe('текст**')
    expect(result.selection).toEqual({ start: 6, end: 6 })
  })

  it('разные маркеры до и после — ссылка', () => {
    const result = wrapSelection('сайт', { start: 0, end: 4 }, '[', '](https://example.com)')
    expect(result.text).toBe('[сайт](https://example.com)')
  })

  it('выделение за границами текста подрезается', () => {
    expect(wrapSelection('abc', { start: 99, end: 99 }, '`').text).toBe('abc``')
    expect(wrapSelection('abc', { start: -5, end: 1 }, '`').text).toBe('`a`bc')
  })
})

describe('insertBlock', () => {
  it('добавляет пустые строки вокруг блока и ставит курсор за ним', () => {
    const result = insertBlock('Абзац', { start: 6, end: 6 }, '| a | b |')
    expect(result.text).toBe('Абзац\n\n| a | b |\n')
    // Курсор за блоком: следующая вставка не затрёт только что добавленное.
    expect(result.selection.start).toBe(result.selection.end)
    expect(result.text.slice(0, result.selection.start).endsWith('| a | b |')).toBe(true)
  })

  it('заменяет выделение, а не оставляет блок поверх него', () => {
    const result = insertBlock('до ВЫДЕЛЕНО после', { start: 3, end: 11 }, '```\nкод\n```')
    expect(result.text).toBe('до \n\n```\nкод\n```\n\n после')
    expect(result.text).not.toContain('ВЫДЕЛЕНО')
  })

  it('не удваивает переводы, если они уже есть', () => {
    const result = insertBlock('Абзац\n\n', { start: 8, end: 8 }, '```mermaid\nA-->B\n```')
    expect(result.text.startsWith('Абзац\n\n```mermaid')).toBe(true)
  })
})

describe('prefixLines', () => {
  it('нумерует или маркирует каждую выделенную строку', () => {
    const text = 'раз\nдва'
    const result = prefixLines(text, { start: 0, end: text.length }, '- ')
    expect(result.text).toBe('- раз\n- два')
  })

  it('пустая строка становится пустым пунктом без хвостового пробела', () => {
    const result = prefixLines('раз\n\nдва', { start: 0, end: 8 }, '- ')
    expect(result.text).toBe('- раз\n-\n- два')
  })

  it('заголовок ставится на строку с курсором', () => {
    const result = heading('Глава первая\n\nТекст', { start: 16, end: 16 }, 3)
    expect(result.text).toContain('### Текст')
  })
})

describe('каркасы', () => {
  it('таблица: шапка, разделитель и строки по числу столбцов', () => {
    const table = tableSkeleton(3, 4)
    const lines = table.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0].split('|').filter((c) => c.trim() !== '')).toHaveLength(4)
    expect(lines[1]).toContain('---')
  })

  it('формула: строчная и выключная', () => {
    expect(formulaSkeleton(false)).toBe('$E = mc^2$')
    expect(formulaSkeleton(true).startsWith('$$')).toBe(true)
  })

  it('диаграммы: все виды дают валидный блок mermaid', () => {
    for (const kind of DIAGRAM_KINDS) {
      const block = diagramSkeleton(kind.id)
      expect(block.startsWith('```mermaid\n')).toBe(true)
      expect(block.endsWith('```')).toBe(true)
      expect(block).toContain(kind.source.split('\n')[0])
    }
  })

  it('неизвестный вид диаграммы даёт схему по умолчанию', () => {
    expect(diagramSkeleton('nope')).toContain('graph TD')
  })

  it('блок кода', () => {
    expect(codeSkeleton('ts')).toBe('```ts\n\n```')
  })
})
