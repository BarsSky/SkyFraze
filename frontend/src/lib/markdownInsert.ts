/**
 * Вставки markdown из панели инструментов редактора.
 *
 * Все функции чистые: принимают текст и позицию выделения, возвращают новый
 * текст и новое выделение. Так их можно проверить тестами и так же использовать
 * и в большом окне редактора, и в поле в панели редакторов.
 */

export interface Selection {
  start: number
  end: number
}

export interface EditResult {
  text: string
  selection: Selection
}

/**
 * Обернуть выделение парой маркеров: `**жирный**`, `*курсив*`, `` `код` ``.
 * Без выделения вставляет пару и ставит курсор внутрь — можно сразу печатать.
 * Выделение подрезается по границам текста (в textarea оно всегда корректное,
 * но вставку зовут и по кнопке, где позиции берутся из состояния React).
 */
export function wrapSelection(text: string, sel: Selection, before: string, after = before): EditResult {
  const { start, end } = normalize(text, sel)
  const inner = text.slice(start, end)
  const next = text.slice(0, start) + before + inner + after + text.slice(end)
  const caret: Selection = inner.length > 0
    ? { start: start + before.length, end: start + before.length + inner.length }
    : { start: start + before.length, end: start + before.length }
  return { text: next, selection: caret }
}

/**
 * Вставить блок на отдельных строках: таблицу, формулу, диаграмму, код.
 * Перед блоком и после него гарантируется пустая строка — иначе markdown
 * склеит его с соседним абзацем. Выделение заменяется, а курсор встаёт ЗА
 * блоком: иначе следующая вставка из панели затрёт только что добавленное
 * (выделение, оставленное на блоке, — это приглашение его потерять).
 */
export function insertBlock(text: string, sel: Selection, block: string): EditResult {
  const { start, end } = normalize(text, sel)
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const tail = after === '' || after.startsWith('\n') ? '\n' : '\n\n'
  const inserted = lead + block + tail
  const next = before + inserted + after
  const caret = before.length + lead.length + block.length
  return { text: next, selection: { start: caret, end: caret } }
}

/**
 * Строки списка/цитаты: добавляет префикс к каждой выделенной строке, а если
 * выделения нет — начинает новую строку с префикса.
 */
export function prefixLines(text: string, sel: Selection, prefix: string): EditResult {
  const { start, end } = normalize(text, sel)
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd < 0) lineEnd = text.length
  const block = text.slice(lineStart, lineEnd)
  const updated = block
    .split('\n')
    .map((line) => (line.trim() === '' ? prefix.trimEnd() : prefix + line))
    .join('\n')
  const next = text.slice(0, lineStart) + updated + text.slice(lineEnd)
  return { text: next, selection: { start: lineStart, end: lineStart + updated.length } }
}

/** Заголовок уровня `level`: строка превращается в `### Текст`. */
export function heading(text: string, sel: Selection, level: number): EditResult {
  return prefixLines(text, sel, '#'.repeat(Math.min(6, Math.max(1, level))) + ' ')
}

/** Каркас таблицы: шапка плюс пустые строки — дальше заполняют по месту. */
export function tableSkeleton(rows = 3, cols = 3): string {
  const width = Math.min(8, Math.max(2, cols))
  const height = Math.min(20, Math.max(2, rows)) - 1
  const head = `| ${Array.from({ length: width }, (_, i) => `Столбец ${i + 1}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  const body = Array.from({ length: height }, () => `| ${Array.from({ length: width }, () => ' ').join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

/** Каркас формулы: строчная или выключная. */
export function formulaSkeleton(display: boolean): string {
  return display ? '$$\nE = mc^2\n$$' : '$E = mc^2$'
}

/** Виды диаграмм Mermaid, которые чаще всего нужны в истории. */
export const DIAGRAM_KINDS = [
  { id: 'flow', label: 'Схема', source: 'graph TD\n  A[Начало] --> B{Развилка}\n  B -->|да| C[Финал]\n  B -->|нет| A' },
  { id: 'sequence', label: 'Последовательность', source: 'sequenceDiagram\n  participant Г as Герой\n  participant М as Мир\n  Г->>М: Вопрос\n  М-->>Г: Ответ' },
  { id: 'timeline', label: 'Хронология', source: 'timeline\n  title Хронология событий\n  Год 1 : Прибытие\n  Год 2 : Первый конфликт' },
  { id: 'mindmap', label: 'Схема связей', source: 'mindmap\n  root((Мир))\n    Герои\n      Протагонист\n      Антагонист\n    Места\n      Колония' },
  { id: 'gantt', label: 'План', source: 'gantt\n  title План работ\n  dateFormat YYYY-MM-DD\n  section Текст\n  Черновик :a1, 2026-01-01, 30d\n  Правка :after a1, 20d' },
  { id: 'state', label: 'Состояния', source: 'stateDiagram-v2\n  [*] --> Спокойствие\n  Спокойствие --> Конфликт\n  Конфликт --> [*]' },
] as const

export function diagramSkeleton(kind: string): string {
  const found = DIAGRAM_KINDS.find((k) => k.id === kind) ?? DIAGRAM_KINDS[0]
  return '```mermaid\n' + found.source + '\n```'
}

/** Блок кода с языком. */
export function codeSkeleton(language = ''): string {
  return '```' + language + '\n\n```'
}

function normalize(text: string, sel: Selection): Selection {
  const start = Math.max(0, Math.min(sel.start, text.length))
  const end = Math.max(start, Math.min(sel.end, text.length))
  return { start, end }
}
