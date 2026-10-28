/**
 * Маркеры DOCX в тексте кадра (0.92.0, docs/docx-template.md §3).
 *
 * Markdown не выражает то, что умеет Word: разрыв страницы, «этот блок — эпиграф из шаблона»,
 * оглавление. Поэтому в тексте кадра живут HTML-комментарии `<-- sf:… -->` (см. MARKER_OPEN):
 *
 *   <!-- sf:pagebreak -->
 *   <!-- sf:toc -->
 *   <!-- sf:style=Имя стиля -->     — следующий блок(и) до конца куска
 *   <!-- sf:begin=Имя --> … <!-- sf:end -->
 *
 * Они **не видны в показе** и **не участвуют в поиске**, но и не сдвигают позиции: упоминания
 * карточек и якоря замечаний хранят `from`/`to` по СЫРОМУ тексту. Поэтому главный приём —
 * `maskDocxMarkers`: символы маркера заменяются заполнителем **той же длины**, строка остаётся
 * на месте. Так поиск и упоминания работают по маске, а позиции остаются валидными для сырого
 * текста.
 *
 * Внутри ``` ``` и ~~~ блоков маркеры не разбираются: это код, а не разметка.
 */

import { insertBlock, type EditResult, type Selection } from './markdownInsert'

/** Начало служебного комментария. */
export const MARKER_OPEN = '<!-- sf:'
/** Конец служебного комментария. */
export const MARKER_CLOSE = '-->'

export type DocxMarkerKind = 'pagebreak' | 'toc' | 'style' | 'begin' | 'end'

export interface DocxMarker {
  kind: DocxMarkerKind
  /** Имя стиля шаблона для style/begin. */
  style?: string
  /** Строка в тексте (с нуля) — чтобы панель могла показать, где маркер стоит. */
  line: number
  /** Исходная строка целиком. */
  source: string
}

/** Что можно вставить из панели «Разметка DOCX». */
export const MARKER_TEMPLATES = [
  { kind: 'pagebreak' as const, label: 'Разрыв страницы', marker: '<!-- sf:pagebreak -->' },
  { kind: 'toc' as const, label: 'Оглавление', marker: '<!-- sf:toc -->' },
  { kind: 'end' as const, label: 'Закончить блок', marker: '<!-- sf:end -->' },
]

/** Маркер «следующий кусок — этим стилем шаблона». */
export function styleMarker(style: string): string {
  return `${MARKER_OPEN}style=${style.trim()} ${MARKER_CLOSE}`
}

/** Маркер «начать кусок этим стилем» (закрывается `<!-- sf:end -->`). */
export function beginMarker(style: string): string {
  return `${MARKER_OPEN}begin=${style.trim()} ${MARKER_CLOSE}`
}

/**
 * Вставить маркер в текст отдельной строкой.
 *
 * Отдельная строка — не украшение: маркер разбирается, только если занимает строку целиком.
 * Реализация — тот же `insertBlock`, что у остальных вставок редактора, чтобы отступы вокруг
 * блока были одинаковыми.
 */
export function insertMarker(text: string, sel: Selection, marker: string): EditResult {
  return insertBlock(text, sel, marker)
}

/**
 * Из чего выбирать стиль в панели: стили абзаца действующего шаблона.
 *
 * Только `paragraph`: стиль знака или таблицы к абзацу не применить, и Word молча оставил бы
 * текст как есть. Нет шаблона — пусто: тогда панель показывает только разрыв и оглавление,
 * а не список несуществующих стилей.
 */
export function docxStyleNames(
  templates: Array<{ is_active: boolean; styles: Array<{ name: string; type: string }> }>,
): string[] {
  const active = templates.find((template) => template.is_active) ?? templates[0]
  if (!active) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const style of active.styles) {
    if (style.type !== 'paragraph') continue
    const name = style.name.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * Разобрать одну строку как маркер. `null` — обычная строка.
 *
 * Разбор намеренно строгий: маркер — это ВСЯ строка (пробелы по краям допустимы). Иначе случайное
 * `<-- sf:... -->` внутри текста вырезалось бы из показа, и человек терял бы кусок текста.
 */
export function parseMarkerLine(line: string, lineIndex = 0): DocxMarker | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(MARKER_OPEN) || !trimmed.endsWith(MARKER_CLOSE)) return null
  const body = trimmed.slice(MARKER_OPEN.length, trimmed.length - MARKER_CLOSE.length).trim()
  if (body === '') return null
  if (body === 'pagebreak') return { kind: 'pagebreak', line: lineIndex, source: line }
  if (body === 'toc') return { kind: 'toc', line: lineIndex, source: line }
  if (body === 'end') return { kind: 'end', line: lineIndex, source: line }
  const styleMatch = /^style=(.+)$/.exec(body)
  if (styleMatch) return { kind: 'style', style: styleMatch[1].trim(), line: lineIndex, source: line }
  const beginMatch = /^begin=(.+)$/.exec(body)
  if (beginMatch) return { kind: 'begin', style: beginMatch[1].trim(), line: lineIndex, source: line }
  // Неизвестная команда: не маркер. Текст сохраняется, а панель/отчёт может сказать «не понял».
  return null
}

/** Идём по строкам, зная, внутри ли мы ``` или ~~~ блока. */
function eachLine(
  text: string,
  visit: (line: string, index: number, inCode: boolean) => void,
): void {
  const lines = text.split('\n')
  let fence: string | null = null
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed)
    if (fence !== null) {
      if (fenceMatch && trimmed.startsWith(fence)) fence = null
      visit(line, index, true)
      return
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      visit(line, index, true)
      return
    }
    visit(line, index, false)
  })
}

/**
 * Заменить маркеры заполнителем, сохранив длину строки.
 *
 * `filler` — пробел по умолчанию: маска остаётся «обычным текстом» для поиска и не прилипает к
 * соседним словам. Внутри строки заполнитель повторяется столько раз, сколько было символов.
 */
export function maskDocxMarkers(text: string, filler = ' '): string {
  if (!text.includes(MARKER_OPEN)) return text
  const lines = text.split('\n')
  eachLine(text, (line, index, inCode) => {
    if (inCode) return
    if (parseMarkerLine(line, index) === null) return
    lines[index] = filler.repeat(line.length)
  })
  return lines.join('\n')
}

/**
 * Убрать строки-маркеры целиком (для отчётов и подсказок).
 *
 * Новую строку оставляем: иначе Markdown-блоки слиплись бы, и «## Заголовок» после маркера
 * оказался бы текстом предыдущего абзаца.
 */
export function stripDocxMarkers(text: string): string {
  if (!text.includes(MARKER_OPEN)) return text
  const lines = text.split('\n')
  eachLine(text, (line, index, inCode) => {
    if (inCode) return
    if (parseMarkerLine(line, index) === null) return
    lines[index] = ''
  })
  return lines.join('\n')
}

/** Все маркеры текста — для панели и проверки «стиль из шаблона?». */
export function listDocxMarkers(text: string): DocxMarker[] {
  if (!text.includes(MARKER_OPEN)) return []
  const out: DocxMarker[] = []
  eachLine(text, (line, index, inCode) => {
    if (inCode) return
    const marker = parseMarkerLine(line, index)
    if (marker !== null) out.push(marker)
  })
  return out
}

/**
 * Проверка маркеров против стилей шаблона: «стиль, которого нет» — не ошибка текста, но человек
 * должен знать, что в DOCX он не применится.
 */
export function unknownMarkers(text: string, styleNames: string[]): DocxMarker[] {
  const known = new Set(styleNames.map((name) => name.toLowerCase()))
  return listDocxMarkers(text).filter(
    (marker) =>
      (marker.kind === 'style' || marker.kind === 'begin') &&
      marker.style !== undefined &&
      !known.has(marker.style.toLowerCase()),
  )
}
