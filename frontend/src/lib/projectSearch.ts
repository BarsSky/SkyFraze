/**
 * projectSearch.ts — поиск по тексту проекта.
 *
 * Почему на клиенте, а не запросом к серверу. Весь текст проекта уже лежит в браузере:
 * это CRDT-документ, который открыт у редактора. Серверная проекция (`events`) отстаёт
 * от документа на период сохранения комнаты (5 с), а несохранённые правки она не видит
 * вовсе — то есть серверный поиск отвечал бы по вчерашнему тексту и «не находил» только
 * что написанный абзац. Здесь же поиск идёт по тому, что человек видит на экране, и
 * стоит он один проход по массиву кадров: считать его на каждое нажатие дешевле, чем
 * ходить в сеть.
 *
 * Чего он НЕ делает (честно, чтобы не обещать лишнего):
 *   - не ищет по другим проектам и по вложениям (PDF, картинки);
 *   - не учитывает морфологию: «главы» не найдёт «глава» — это подстрочный поиск,
 *     как в фильтре по названию, который был здесь раньше.
 *
 * Разметка Markdown не вычищается: человек ищет то, что написал, и «## Начало» в
 * сниппете — правда о тексте, а не мусор.
 */

/** Кадр для поиска: то, что панель редакторов уже читает из документа. */
import { maskDocxMarkers } from './docxMarkers'

export interface SearchableFrame {
  id: string
  title: string
  body: string
}

/** Совпадение: кадр и кусок текста вокруг найденного. */
export interface SearchHit {
  id: string
  title: string
  /**
   * Кусок текста вокруг совпадения (у попадания в заголовок — начало текста).
   * Пустая строка, если текста нет.
   */
  snippet: string
  /** Совпадение в заголовке: такие кадры идут первыми. */
  inTitle: boolean
}

/** Сколько знаков текста показывать вокруг совпадения. */
const SNIPPET_AROUND = 60

/**
 * Найти кадры, в названии или тексте которых есть `query`.
 *
 * Порядок: сначала попадания в название (по дереву), затем попадания в текст (тоже по
 * дереву) — «нашёл главу по названию» должно быть выше случайного слова в тексте.
 * Пустой запрос не ищет ничего: панель показывает все кадры, и это её обычное состояние.
 */
export function searchProject(
  frames: ReadonlyArray<SearchableFrame>,
  query: string,
  limit = 200,
): SearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const inTitle: SearchHit[] = []
  const inBody: SearchHit[] = []
  for (const frame of frames) {
    // Маркеры DOCX (0.92.0) в поиске не участвуют: иначе «sf», «style» и имена стилей находились
    // бы в каждом кадре, где стоит маркер. Маска сохраняет длину — сниппет режется по тем же
    // местам, что и раньше, только вместо маркера в нём пробелы.
    const maskedTitle = maskDocxMarkers(frame.title)
    const maskedBody = maskDocxMarkers(frame.body)
    if (maskedTitle.toLowerCase().includes(needle)) {
      inTitle.push({
        id: frame.id,
        title: frame.title,
        snippet: snippetAround(maskedBody, needle),
        inTitle: true,
      })
      continue
    }
    const index = maskedBody.toLowerCase().indexOf(needle)
    if (index >= 0) {
      inBody.push({
        id: frame.id,
        title: frame.title,
        snippet: snippetAround(maskedBody, needle),
        inTitle: false,
      })
    }
    if (inTitle.length + inBody.length >= limit) break
  }
  return [...inTitle, ...inBody].slice(0, limit)
}

/**
 * Кусок текста вокруг первого совпадения.
 *
 * Границы режутся по словам, где это возможно: обрывок «сть главы» читается как
 * опечатка, а «…часть главы…» — как цитата. Переводы строк заменяются пробелом:
 * сниппет живёт в одну строку списка, и многострочный текст в нём не помещается.
 */
export function snippetAround(body: string, needle: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  // Позиция ищется в «плоском» тексте заново: исходная может указывать в текст с
  // переводами строк, а показать надо плоский. Нижний регистр — тот же, что у needle.
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) {
    // Совпадения в тексте нет (запрос попал в название) — показываем начало: по нему
    // видно, о чём кадр, и это дешевле, чем ничего.
    return cutStart(flat, SNIPPET_AROUND * 2)
  }
  let start = Math.max(0, at - SNIPPET_AROUND)
  let end = Math.min(flat.length, at + needle.length + SNIPPET_AROUND)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at + needle.length) end = space
  }
  const piece = flat.slice(start, end)
  return `${start > 0 ? '…' : ''}${piece}${end < flat.length ? '…' : ''}`
}

/** Начало текста, обрезанное по слову. */
function cutStart(flat: string, length: number): string {
  if (flat.length <= length) return flat
  const space = flat.lastIndexOf(' ', length)
  const end = space > 0 ? space : length
  return `${flat.slice(0, end)}…`
}

/** Есть ли что искать: пустая строка и одни пробелы запросом не считаются. */
export function isSearchQuery(query: string): boolean {
  return query.trim() !== ''
}
