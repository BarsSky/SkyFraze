import { describe, expect, it } from 'vitest'
import {
  MARKER_TEMPLATES,
  beginMarker,
  docxStyleNames,
  insertMarker,
  listDocxMarkers,
  maskDocxMarkers,
  parseMarkerLine,
  stripDocxMarkers,
  styleMarker,
  unknownMarkers,
} from './docxMarkers'

/**
 * Маркеры DOCX (0.92.0): невидимы в показе и поиске, но не сдвигают позиции.
 *
 * Самое важное здесь — длина: `maskDocxMarkers` обязан сохранить длину строки, иначе сдвинутся
 * позиции упоминаний карточек и якорей замечаний, которые хранятся по сырому тексту.
 */

describe('parseMarkerLine', () => {
  it('знает команды словаря', () => {
    expect(parseMarkerLine('<!-- sf:pagebreak -->')?.kind).toBe('pagebreak')
    expect(parseMarkerLine('<!-- sf:toc -->')?.kind).toBe('toc')
    expect(parseMarkerLine('<!-- sf:end -->')?.kind).toBe('end')
    expect(parseMarkerLine('<!-- sf:style=Эпиграф -->')).toMatchObject({
      kind: 'style',
      style: 'Эпиграф',
    })
    expect(parseMarkerLine('  <!-- sf:begin=Стих -->  ')?.style).toBe('Стих')
  })

  it('обычная строка и неизвестная команда — не маркеры', () => {
    expect(parseMarkerLine('Анна вошла в дом')).toBeNull()
    expect(parseMarkerLine('<!-- sf:что-то новое -->')).toBeNull()
    expect(parseMarkerLine('<!-- обычный комментарий -->')).toBeNull()
    // Маркер — вся строка целиком: внутри текста не разбирается, иначе человек терял бы кусок.
    expect(parseMarkerLine('текст <!-- sf:toc --> текст')).toBeNull()
  })
})

describe('maskDocxMarkers — маска без сдвига позиций', () => {
  const text = ['# Глава', '', '<!-- sf:pagebreak -->', 'Анна вошла.', '<!-- sf:style=Эпиграф -->', 'Так начинается ночь.'].join('\n')

  it('заменяет маркеры, сохраняя длину каждой строки', () => {
    const masked = maskDocxMarkers(text)
    expect(masked.length).toBe(text.length)
    expect(masked.split('\n').length).toBe(text.split('\n').length)
    expect(masked).not.toContain('sf:')
    // Позиция «Анна» в маске та же, что в сыром тексте.
    expect(masked.indexOf('Анна')).toBe(text.indexOf('Анна'))
    expect(masked).toContain('Анна вошла.')
  })

  it('внутри ``` блоков маркеры не трогает: это код', () => {
    const code = ['```html', '<!-- sf:pagebreak -->', '```'].join('\n')
    expect(maskDocxMarkers(code)).toBe(code)
  })

  it('оставляет обычные HTML-комментарии как есть', () => {
    const withComment = '<!-- обычный комментарий -->\nтекст'
    expect(maskDocxMarkers(withComment)).toBe(withComment)
  })
})

describe('stripDocxMarkers и список', () => {
  it('строки маркеров становятся пустыми, текст остаётся', () => {
    const text = '<!-- sf:toc -->\nАнна\n<!-- sf:pagebreak -->'
    const stripped = stripDocxMarkers(text)
    expect(stripped.split('\n')[0]).toBe('')
    expect(stripped).toContain('Анна')
    expect(stripped).not.toContain('sf:')
  })

  it('listDocxMarkers отдаёт маркеры с номерами строк и не считает код', () => {
    const text = ['1', '<!-- sf:pagebreak -->', '2', '```', '<!-- sf:toc -->', '```', '<!-- sf:style=Стих -->'].join('\n')
    const markers = listDocxMarkers(text)
    expect(markers.map((marker) => marker.kind)).toEqual(['pagebreak', 'style'])
    expect(markers[0].line).toBe(1)
    expect(markers[1].style).toBe('Стих')
  })

  it('unknownMarkers говорит, какие стили не из шаблона', () => {
    const text = '<!-- sf:style=Эпиграф -->\nтекст\n<!-- sf:begin=Нет такого -->'
    const unknown = unknownMarkers(text, ['Эпиграф', 'Стих'])
    expect(unknown).toHaveLength(1)
    expect(unknown[0].style).toBe('Нет такого')
  })

  it('шаблоны для вставки содержат готовые строки', () => {
    expect(MARKER_TEMPLATES.map((item) => item.marker)).toContain('<!-- sf:pagebreak -->')
    expect(MARKER_TEMPLATES.map((item) => item.marker)).toContain('<!-- sf:toc -->')
  })
})

/**
 * Панель «Разметка DOCX»: что она вставляет и из чего выбирает стиль.
 *
 * Вставляет именно СТРОКУ ЦЕЛИКОМ и с пустыми строками вокруг: маркер, приклеенный к тексту,
 * разбор не увидит, и человек решил бы, что кнопка не работает.
 */
describe('вставка маркеров', () => {
  it('маркер со стилем разбирается обратно тем же парсером', () => {
    expect(parseMarkerLine(styleMarker('Эпиграф'))).toMatchObject({ kind: 'style', style: 'Эпиграф' })
    expect(parseMarkerLine(beginMarker(' Стих '))).toMatchObject({ kind: 'begin', style: 'Стих' })
  })

  it('вставляет маркер отдельной строкой', () => {
    const text = 'Первый абзац.\n\nВторой абзац.'
    const result = insertMarker(text, { start: 15, end: 15 }, MARKER_TEMPLATES[0].marker)
    expect(result.text).toContain('\n\n<!-- sf:pagebreak -->\n')
    // Разбор находит его — значит, строка действительно отдельная.
    expect(listDocxMarkers(result.text).map((marker) => marker.kind)).toEqual(['pagebreak'])
    // Курсор остался после вставленного маркера.
    expect(result.selection.start).toBe(result.text.indexOf('<!-- sf:pagebreak -->') + MARKER_TEMPLATES[0].marker.length)
  })

  it('в пустом тексте маркер не приклеивается к предыдущей строке', () => {
    const result = insertMarker('', { start: 0, end: 0 }, styleMarker('Стих'))
    expect(result.text.startsWith('<!-- sf:style=Стих -->')).toBe(true)
  })
})

describe('docxStyleNames', () => {
  const template = (active: boolean, styles: Array<{ name: string; type: string }>) => ({
    is_active: active,
    styles,
  })

  it('берёт стили абзаца действующего шаблона', () => {
    const names = docxStyleNames([
      template(false, [{ name: 'Из старого', type: 'paragraph' }]),
      template(true, [
        { name: 'Стих', type: 'paragraph' },
        { name: 'Знак', type: 'character' },
        { name: 'Таблица', type: 'table' },
        { name: 'Стих', type: 'paragraph' },
        { name: '  ', type: 'paragraph' },
      ]),
    ])
    expect(names).toEqual(['Стих'])
  })

  it('нет действующего — берёт первый (шаблон мог ещё не активироваться)', () => {
    expect(docxStyleNames([template(false, [{ name: 'Эпиграф', type: 'paragraph' }])])).toEqual(['Эпиграф'])
  })

  it('шаблонов нет — пустой список, а не выдуманные имена', () => {
    expect(docxStyleNames([])).toEqual([])
  })
})
