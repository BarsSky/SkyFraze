import { locateQuote } from './storySelection'

/**
 * Подсветка фразы в показе проекта (0.133.0).
 *
 * Зачем отдельный модуль. Показ рендерит Markdown, и «найти фразу в тексте» здесь — это найти её
 * в ОТРИСОВАННОМ тексте: на входе есть кадр и цитата, а не смещения в исходнике (те нужны
 * редакторам, см. `locateQuote`). Обратный переход — «показать в проекте» из чата и из
 * редакторов — приходит ровно в таком виде.
 *
 * Почему CSS Custom Highlight API, а не обёртка в `<mark>`. Разметку кадра держит React, и вставка
 * своих узлов в его дерево ломает сверку при следующей перерисовке. Highlight API красит диапазон,
 * не трогая DOM вовсе. Обёртка остаётся запасным путём для браузеров без этого API — и это же путь,
 * который работает в jsdom (там API нет), то есть он честно покрыт тестами.
 */

/** Имя подсветки: стиль задаётся селектором `::highlight(sf-quote)`. */
export const QUOTE_HIGHLIGHT = 'sf-quote'

interface Chunk {
  node: Text
  /** Начало текстового узла в сквозной строке. */
  start: number
  /** Конец (не включая) в сквозной строке. */
  end: number
}

interface Located {
  text: string
  chunks: Chunk[]
  from: number
  to: number
}

/**
 * Сквозной текст контейнера и карта «смещение в строке → текстовый узел».
 *
 * Между узлами вставляется `\n`: блоки (`<p>`, `<li>`, `<h2>`) в конкатенации склеились бы
 * («НачалоТак начинается»), и поиск по словам перестал бы их различать. Разделитель занимает своё
 * место в строке, поэтому смещения остаются честными.
 */
function textChunks(root: HTMLElement): { text: string; chunks: Chunk[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const chunks: Chunk[] = []
  let text = ''
  let node = walker.nextNode() as Text | null
  while (node !== null) {
    const data = node.data
    if (data.length > 0) {
      chunks.push({ node, start: text.length, end: text.length + data.length })
      text += `${data}\n`
    }
    node = walker.nextNode() as Text | null
  }
  return { text, chunks }
}

/** Где фраза лежит в отрисованном тексте: сквозные смещения + карта узлов. */
function locateIn(root: HTMLElement, quote: string): Located | null {
  const needle = quote.trim()
  if (!needle) return null
  const { text, chunks } = textChunks(root)
  if (chunks.length === 0) return null
  const found = locateQuote(text, needle)
  if (found === null) return null
  return { text, chunks, from: found.from, to: found.to }
}

/** Точка диапазона в DOM по смещению в сквозной строке. */
function pointAt(chunks: Chunk[], offset: number, edge: 'start' | 'end'): { node: Text; offset: number } | null {
  if (edge === 'start') {
    for (const chunk of chunks) {
      if (offset >= chunk.start && offset < chunk.end) {
        return { node: chunk.node, offset: offset - chunk.start }
      }
    }
    return null
  }
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (offset > chunk.start && offset <= chunk.end) {
      return { node: chunk.node, offset: offset - chunk.start }
    }
  }
  return null
}

/**
 * Найти фразу в отрисованном тексте кадра.
 *
 * `null` — фразы в этом тексте нет: соавтор мог переписать абзац, или в показе она выглядит иначе
 * (Markdown снят, ссылка показывает текст вместо адреса). Подсветить «примерно там» нельзя:
 * человек решит, что обсуждали не то.
 */
export function findQuoteRange(root: HTMLElement, quote: string): Range | null {
  const located = locateIn(root, quote)
  if (located === null) return null
  const start = pointAt(located.chunks, located.from, 'start')
  const end = pointAt(located.chunks, located.to, 'end')
  if (start === null || end === null) return null
  try {
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  } catch {
    return null
  }
}

export interface QuoteHighlight {
  /** Нашлась ли фраза: если нет — подсветки нет, и об этом надо сказать, а не молчать. */
  found: boolean
  /** Снять подсветку. Безопасно вызывать повторно. */
  clear: () => void
}

const nothing = () => undefined

interface HighlightRegistryLike {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => boolean
}
type HighlightCtor = new (...ranges: Range[]) => unknown

/**
 * Подсветить фразу в показе кадра.
 *
 * Стиль живёт в CSS (`::highlight(sf-quote)` и `.sf-quote-mark`), поэтому цвет задаёт тема, а не
 * этот модуль. Возврат — признак «нашлось» и снятие: подсветка не должна пережить переход к
 * другому кадру.
 */
export function highlightQuote(root: HTMLElement, quote: string): QuoteHighlight {
  const located = locateIn(root, quote)
  if (located === null) return { found: false, clear: nothing }

  const registry =
    typeof CSS === 'undefined'
      ? undefined
      : (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights
  const HighlightClass = (window as unknown as { Highlight?: HighlightCtor }).Highlight
  if (registry !== undefined && HighlightClass !== undefined) {
    const range = findQuoteRange(root, quote)
    if (range === null) return { found: false, clear: nothing }
    registry.set(QUOTE_HIGHLIGHT, new HighlightClass(range))
    return { found: true, clear: () => registry.delete(QUOTE_HIGHLIGHT) }
  }

  // Запасной путь: обёртка найденных кусков в `<mark>`. Идём с конца, чтобы `splitText` не сдвигал
  // смещения ещё не обработанных узлов.
  const marks: HTMLElement[] = []
  const overlaps = located.chunks.filter(
    (chunk) => chunk.start < located.to && chunk.end > located.from,
  )
  for (let index = overlaps.length - 1; index >= 0; index -= 1) {
    const chunk = overlaps[index]
    const from = Math.max(0, located.from - chunk.start)
    const to = Math.min(chunk.node.data.length, located.to - chunk.start)
    if (to <= from) continue
    try {
      const middle = from === 0 ? chunk.node : chunk.node.splitText(from)
      middle.splitText(to - from)
      const mark = document.createElement('mark')
      mark.className = 'sf-quote-mark'
      mark.setAttribute('data-quote-mark', '')
      middle.parentNode?.insertBefore(mark, middle)
      mark.appendChild(middle)
      marks.push(mark)
    } catch {
      // Узел уже разбит соседним куском — его часть просто не подсвечиваем.
    }
  }
  if (marks.length === 0) return { found: false, clear: nothing }
  return {
    found: true,
    clear: () => {
      for (const mark of marks) {
        if (!mark.isConnected) continue
        const parent = mark.parentNode
        mark.replaceWith(...Array.from(mark.childNodes))
        parent?.normalize()
      }
      marks.length = 0
    },
  }
}
