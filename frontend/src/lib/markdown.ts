import MarkdownItCtor, { type MarkdownIt, type StateBlock, type StateInline } from 'markdown-it'
import DOMPurify from 'dompurify'

/**
 * Markdown в тексте события.
 *
 * Разметку рендерим в ДВА шага, и это важно:
 *   1. markdown-it превращает текст в HTML, но формулы и диаграммы оставляет
 *      «заготовками» — пустыми узлами с исходником ВНУТРИ элемента;
 *   2. DOMPurify вычищает результат (текст пишут люди, а показывается он и в
 *      публичной истории — без санитайза это дыра);
 *   3. уже после вставки в DOM компонент MarkdownBlock оживляет заготовки:
 *      KaTeX рисует формулы, Mermaid — диаграммы. Обе библиотеки тяжёлые,
 *      поэтому грузятся динамически и только если в тексте они правда есть.
 *
 * Исходник лежит в тексте узла, а не в data-атрибуте: DOMPurify выбрасывает
 * атрибут, если в значении есть `-->` (защита от выхода из HTML-комментария), а
 * это самый частый синтаксис mermaid — «A --> B». В тексте узла стрелка цела.
 *
 * Сырой HTML в разметке запрещён (`html: false`): форматирования из markdown
 * достаточно, а произвольные теги в общем тексте не нужны.
 */

export interface MarkdownResult {
  /** Очищенный HTML с заготовками формул и диаграмм. */
  html: string
  /** Есть ли формулы: если нет — KaTeX не загружаем. */
  hasMath: boolean
  /** Есть ли блоки ```mermaid: если нет — Mermaid не загружаем. */
  hasDiagram: boolean
}

/** Классы заготовок: по ним компонент находит узлы для оживления. */
export const MATH_CLASS = 'sf-md-math'
export const DIAGRAM_CLASS = 'sf-md-mermaid'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `$$…$$` — формула отдельным блоком (в том числе в несколько строк). */
function mathBlockRule(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'sf_math_block', (state: StateBlock, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    const line = state.src.slice(start, max)
    if (!line.startsWith('$$')) return false

    const oneLine = /^\$\$\s*([\s\S]*?)\s*\$\$\s*$/.exec(line)
    if (oneLine) {
      if (silent) return true
      const token = state.push('sf_math_block', 'div', 0)
      token.content = oneLine[1]
      token.map = [startLine, startLine + 1]
      state.line = startLine + 1
      return true
    }

    // Открыли $$ и ищем закрывающие на следующих строках.
    let cursor = startLine + 1
    let content = line.slice(2)
    let closed = false
    while (cursor < endLine) {
      const s = state.bMarks[cursor] + state.tShift[cursor]
      const e = state.eMarks[cursor]
      const text = state.src.slice(s, e)
      const close = text.indexOf('$$')
      if (close >= 0) {
        content += '\n' + text.slice(0, close)
        closed = true
        cursor++
        break
      }
      content += '\n' + text
      cursor++
    }
    if (!closed) return false
    if (silent) return true

    const token = state.push('sf_math_block', 'div', 0)
    token.content = content.trim()
    token.map = [startLine, cursor]
    state.line = cursor
    return true
  })
}

/**
 * `$…$` внутри строки.
 *
 * Отдельно оговорены частые ложные срабатывания: «$5 и $6» — это цены, а не
 * формула, поэтому содержимое не может начинаться или заканчиваться пробелом,
 * а пустая пара `$$` формулой не считается.
 */
function mathInlineRule(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'sf_math_inline', (state: StateInline, silent) => {
    const start = state.pos
    const src = state.src
    if (src.charCodeAt(start) !== 0x24) return false // '$'
    if (src.charCodeAt(start + 1) === 0x24) return false // '$$' — это блок

    let pos = start + 1
    let close = -1
    while (pos < state.posMax) {
      const ch = src.charCodeAt(pos)
      if (ch === 0x5c) {
        pos += 2
        continue
      }
      if (ch === 0x24) {
        close = pos
        break
      }
      pos++
    }
    if (close < 0 || close === start + 1) return false
    const content = src.slice(start + 1, close)
    if (/^\s|\s$/.test(content)) return false

    if (!silent) {
      const token = state.push('sf_math_inline', 'span', 0)
      token.content = content
    }
    state.pos = close + 1
    return true
  })
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownItCtor({
    // Сырой HTML запрещён: разметку пишут люди, а показывается она публично.
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
  })
  mathBlockRule(md)
  mathInlineRule(md)

  const defaultFence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info.trim().toLowerCase()
    if (info === 'mermaid') {
      return `<div class="${DIAGRAM_CLASS}">${escapeHtml(token.content.trim())}</div>`
    }
    return defaultFence(tokens, idx, options, env, self)
  }

  md.renderer.rules.sf_math_inline = (tokens, idx) =>
    `<span class="${MATH_CLASS}">${escapeHtml(tokens[idx].content)}</span>`
  md.renderer.rules.sf_math_block = (tokens, idx) =>
    `<div class="${MATH_CLASS} ${MATH_CLASS}--block">${escapeHtml(tokens[idx].content)}</div>`

  // Ссылки из markdown открываются в новой вкладке и не тащат за собой opener.
  const defaultLinkOpen = md.renderer.rules.link_open
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return defaultLinkOpen
      ? defaultLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }
  return md
}

const renderer = createRenderer()

/** Что разрешено в готовом HTML: только то, что даёт markdown, и наши заготовки. */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote',
    'strong', 'em', 's', 'del', 'ins', 'mark', 'sup', 'sub',
    'ul', 'ol', 'li',
    'code', 'pre',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'span', 'div',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'target', 'rel', 'src', 'alt',
    'class', 'align', 'colspan', 'rowspan',
  ],
  // ALLOWED_URI_REGEXP НЕ переопределяем: свой слишком строгий шаблон DOMPurify
  // применяет и к обычным атрибутам — тогда молча пропадали target и rel
  // («открыть в новой вкладке» переставало работать). Встроенная проверка уже
  // отсекает javascript: и data:text/html.
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
}

/**
 * Прозрачный пиксель: им подменяется картинка проекта, файл которой страница ещё
 * не загрузила. Пустой `src` браузер понимает как адрес самой страницы, а сырой
 * `/api/assets/<id>` без заголовка даёт 401 в консоли — оба варианта хуже:
 * картинка появится, как только blob доедет (MarkdownBlock перерисуется).
 */
const PENDING_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * Разметка → очищенный HTML с заготовками.
 *
 * Чистая функция без побочных эффектов: её же использует и предпросмотр в
 * редакторе, и кадр таймлайна, и публичная страница истории.
 *
 * `assetUrls` — файлы проекта, уже доступные странице (id → адрес). Ссылки
 * `/api/assets/<id>` в тексте заменяются на него: этот адрес работает в скачанном
 * .md и на публичной странице, но в приложении требует авторизации, а тег `<img>`
 * заголовок не несёт — без подмены картинка в тексте не открывалась бы (401).
 */
export function renderMarkdown(source: string, assetUrls?: Record<string, string>): MarkdownResult {
  const text = source ?? ''
  if (text.trim() === '') return { html: '', hasMath: false, hasDiagram: false }

  const raw = renderer.render(text)
  let html = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string
  if (assetUrls) {
    html = html.replace(/\b(src|href)="\/api\/assets\/([^"]+)"/g, (whole, attr: string, id: string) => {
      const url = assetUrls[id]
      if (url) return `${attr}="${url}"`
      // Ссылку оставляем как есть: переход по ней — осознанное действие человека.
      // Картинку без файла показываем пустой, чтобы не было ни 401, ни «пустого» src.
      return attr === 'src' ? `${attr}="${PENDING_IMAGE}"` : whole
    })
  }
  return {
    html,
    hasMath: html.includes(MATH_CLASS),
    hasDiagram: html.includes(DIAGRAM_CLASS),
  }
}

/** Есть ли в тексте хоть какая-то разметка — для подсказок в интерфейсе. */
export function looksLikeMarkdown(source: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)|\*\*|__|`[^`]|\$[^$]/.test(source ?? '')
}
