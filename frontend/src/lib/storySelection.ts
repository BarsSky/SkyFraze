/**
 * Выделение фрагмента в показе проекта (0.132.0).
 *
 * Зачем отдельный модуль. Выделить текст в кадре и что-то с ним сделать — три РАЗНЫХ адресата:
 * ссылка в чат проекта (люди), вопрос помощнику (модель) и правка фрагмента (редакторы). Все три
 * живут в разных местах страницы: чат и помощник — в плавающем окне, редакторы — на своей вкладке.
 * Протаскивать колбэки через дерево значило бы связать стадию с доком, док — со страницей, а
 * страницу — с редакторами; событие здесь дешевле и проверяется тестом.
 *
 * Выделение в показе — это DOM-текст отрисованного Markdown, а редакторы работают со СМЕЩЕНИЯМИ в
 * исходном тексте кадра. Смещения восстанавливаются поиском выделенного куска в исходнике
 * (`locateQuote`): точное совпадение, затем «по словам» (в показе разметка уже снята, и переводы
 * строк в исходнике не совпадают с выделением), затем первая строка, затем первое предложение. Не
 * нашлось — фрагмент всё равно уходит в чат и помощнику (цитата есть), а быстрая правка честно
 * говорит, что место в исходнике не найдено, и предлагает открыть кадр в редакторах. Подсветить
 * не тот фрагмент хуже, чем не подсветить никакой.
 */

/** Что именно выделили: кадр, цитата и (если нашли) смещения в исходном тексте кадра. */
export interface FrameQuote {
  frameId: string
  frameTitle: string
  quote: string
  /** Смещения в исходном Markdown кадра; `null` — выделение в исходнике не нашлось. */
  range: { from: number; to: number } | null
}

/** Отправить цитату в чат проекта. */
export const QUOTE_TO_CHAT_EVENT = 'skyfraze:quote-to-chat'
/** Отправить цитату в чат помощника. */
export const QUOTE_TO_ASSISTANT_EVENT = 'skyfraze:quote-to-assistant'
/** Открыть окно быстрой правки фрагмента. */
export const QUOTE_EDIT_EVENT = 'skyfraze:quote-edit'
/**
 * Ссылка на фразу в публичной истории (0.136.0).
 *
 * Отдельное событие, а не «в чат проекта»: на публичной странице читателя нет ни чата, ни
 * редакторов, и единственное осмысленное действие с выделением — получить адрес, который
 * открывает ту же историю на этом кадре с подсвеченной фразой.
 */
export const QUOTE_LINK_EVENT = 'skyfraze:quote-link'

/** Окно быстрой правки: что править и где. */
export interface QuoteEditRequest extends FrameQuote {
  /** Меняется на каждое выделение: по нему окно понимает, что просят другой фрагмент. */
  nonce: number
}

function dispatch<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<T>(name, { detail }))
}

function subscribe<T>(name: string, handler: (detail: T) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<T>).detail
    if (detail) handler(detail)
  }
  window.addEventListener(name, listener)
  return () => window.removeEventListener(name, listener)
}

export function requestQuoteToChat(quote: FrameQuote): void {
  dispatch(QUOTE_TO_CHAT_EVENT, quote)
}
export function onQuoteToChat(handler: (quote: FrameQuote) => void): () => void {
  return subscribe(QUOTE_TO_CHAT_EVENT, handler)
}

export function requestQuoteToAssistant(quote: FrameQuote): void {
  dispatch(QUOTE_TO_ASSISTANT_EVENT, quote)
}
export function onQuoteToAssistant(handler: (quote: FrameQuote) => void): () => void {
  return subscribe(QUOTE_TO_ASSISTANT_EVENT, handler)
}

export function requestQuoteEdit(quote: FrameQuote): void {
  dispatch<QuoteEditRequest>(QUOTE_EDIT_EVENT, { ...quote, nonce: Date.now() })
}
export function onQuoteEdit(handler: (request: QuoteEditRequest) => void): () => void {
  return subscribe(QUOTE_EDIT_EVENT, handler)
}

/** Попросить ссылку на фразу (публичная история, 0.136.0). */
export function requestQuoteLink(quote: FrameQuote): void {
  dispatch(QUOTE_LINK_EVENT, quote)
}
export function onQuoteLink(handler: (quote: FrameQuote) => void): () => void {
  return subscribe(QUOTE_LINK_EVENT, handler)
}

/** Слово с его местом в строке: по ним выделение ищется в исходнике независимо от разметки. */
interface WordAt {
  word: string
  start: number
  end: number
}

function wordsOf(text: string): WordAt[] {
  // `u` нужен ради `\p{L}`: слово — это буквы и цифры, а не «всё до пробела».
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu
  const result: WordAt[] = []
  for (const match of text.matchAll(pattern)) {
    result.push({ word: match[0], start: match.index, end: match.index + match[0].length })
  }
  return result
}

/**
 * Найти выделение по словам, а не по точной строке.
 *
 * Зачем не регулярка «слова через `\\s+`». Показ рендерит Markdown, поэтому между словами в
 * исходнике может стоять что угодно: `**` вокруг жирного, `_` вокруг курсива, пустая строка
 * между абзацами, `-` в начале пункта списка, `#` у заголовка. Перечислять эти вставки шаблоном
 * значит заведомо пропустить половину, поэтому слова сравниваются по отдельности: они обязаны
 * идти подряд и в том же порядке, а что стоит между ними — неважно.
 *
 * Первое и последнее слово сравниваются с конца и с начала: человек может выделить фразу с
 * середины слова (`ошла` в «вошла»), и такое выделение всё ещё указывает на это место.
 */
function locateByWords(source: string, quote: string): { from: number; to: number } | null {
  const want = wordsOf(quote)
  if (want.length === 0) return null
  const hay = wordsOf(source)
  const last = want.length - 1

  for (let i = 0; i + want.length <= hay.length; i += 1) {
    const first = hay[i]
    const firstWord = first.word.toLowerCase()
    const lastToken = hay[i + last]
    const lastWord = lastToken.word.toLowerCase()
    const wantFirst = want[0].word.toLowerCase()
    const wantLast = want[last].word.toLowerCase()

    // Края могут быть обрезаны: выделение с середины слова и по середину слова.
    if (!firstWord.endsWith(wantFirst) || !lastWord.startsWith(wantLast)) continue

    let ok = true
    for (let j = 1; j < last; j += 1) {
      if (hay[i + j].word.toLowerCase() !== want[j].word.toLowerCase()) {
        ok = false
        break
      }
    }
    if (!ok) continue

    return {
      from: first.end - wantFirst.length,
      to: lastToken.start + wantLast.length,
    }
  }
  return null
}

/**
 * Где выделенный текст лежит в исходнике кадра.
 *
 * Порядок попыток — от точного к приблизительному, и каждая следующая нужна не «на всякий
 * случай»: показ рендерит Markdown, поэтому выделение через абзац приходит без `**` и без пустых
 * строк, и точное совпадение по такому куску не находится.
 */
export function locateQuote(source: string, quote: string): { from: number; to: number } | null {
  const needle = quote.trim()
  if (!needle) return null

  const exact = source.indexOf(needle)
  if (exact >= 0) return { from: exact, to: exact + needle.length }

  const byWords = locateByWords(source, needle)
  if (byWords) return byWords

  // Первая непустая строка выделения: человек часто выделяет абзац с начала.
  const firstLine = needle
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (firstLine && firstLine !== needle) {
    const at = source.indexOf(firstLine)
    if (at >= 0) return { from: at, to: at + firstLine.length }
  }

  // Первое предложение: если абзац отрисован с переносами, оно всё равно найдётся.
  const sentence = needle.split(/(?<=[.!?…])\s+/)[0]?.trim() ?? ''
  if (sentence.length >= 8 && sentence !== needle) {
    const at = source.indexOf(sentence)
    if (at >= 0) return { from: at, to: at + sentence.length }
  }

  return null
}
