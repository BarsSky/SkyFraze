/**
 * Упоминания в обсуждении: разбор текста, подсказка по `@` и вставка ника.
 *
 * Зачем отдельный модуль. Разбор упоминаний есть на сервере (`events.ParseMentions`), и там он
 * решает «кого позвать». Здесь — то, что видит человек: подсветка ника в тексте и подсказка
 * участников проекта при наборе `@`. Держать это в компоненте обсуждения значило бы
 * повторять регулярку в двух местах экрана (замечание и ответ), а разойтись они могут молча.
 *
 * Регулярка подогнана под серверные правила ник-а (`store.NormalizeUsername`): латиница,
 * цифры, точка, дефис, подчёркивание, от 3 до 32 знаков, без точки/дефиса/подчёркивания по
 * краям. Поэтому `editor@example.com` из текста не превращается в упоминание, а `@Серёжа`
 * подсветку не получает — такого ника в проекте не бывает.
 */

/** Куски текста: обычный текст и упоминания (по ним рисуется подсветка). */
export interface MentionPart {
  text: string
  mention: boolean
}

/**
 * Ник в тексте: минимум три знака (`@ok` — это не ник, а «ок»), не заканчивается на точку,
 * дефис или подчёркивание. Тот же минимум у ника в профиле (`store.NormalizeUsername`).
 */
const HANDLE = '@[A-Za-z0-9_][A-Za-z0-9_.-]{1,30}[A-Za-z0-9_]'

/** Регулярка с границей перед `@`: перед ником не может стоять буква, цифра или `@`. */
const MENTION_RE = new RegExp(`(?:^|[^\\w@])(${HANDLE})`, 'g')

/** Разбивает текст на куски, помечая упоминания. Пустой текст — пустой список. */
export function splitMentions(text: string): MentionPart[] {
  if (!text) return []
  const parts: MentionPart[] = []
  let last = 0
  for (const match of text.matchAll(MENTION_RE)) {
    const full = match[0]
    const handle = match[1]
    const start = (match.index ?? 0) + (full.length - handle.length)
    if (start > last) parts.push({ text: text.slice(last, start), mention: false })
    parts.push({ text: handle, mention: true })
    last = start + handle.length
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false })
  return parts
}

/**
 * Что человек набирает после `@` до каретки: `{ start, query }` или null.
 *
 * `start` — позиция самой собаки: по ней вставка заменяет набранный кусок целиком, а не
 * дописывает ник к опечатке.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  // Между собакой и кареткой — только допустимые для ника символы; иначе это не упоминание.
  if (!/^[A-Za-z0-9_.-]*$/.test(query)) return null
  // Перед собакой не должно быть буквы, цифры или ещё одной собаки (иначе email).
  const prev = at > 0 ? before[at - 1] : ''
  if (prev && /[\w@]/.test(prev)) return null
  return { start: at, query }
}

/** Вставляет выбранный ник вместо набранного куска и возвращает текст и новую каретку. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  username: string,
): { text: string; caret: number } {
  const head = text.slice(0, start)
  const tail = text.slice(Math.max(start, caret))
  const inserted = `@${username} `
  return {
    text: head + inserted + tail,
    caret: (head + inserted).length,
  }
}

/** Кто из участников подходит под набранный кусок (по нику или по имени). */
export function matchMentionCandidates<T extends { username?: string; displayName?: string }>(
  candidates: T[],
  query: string,
  limit = 5,
): T[] {
  const needle = query.trim().toLowerCase()
  const out: T[] = []
  for (const candidate of candidates) {
    const username = (candidate.username ?? '').toLowerCase()
    if (!username) continue
    if (needle && !username.startsWith(needle)) continue
    out.push(candidate)
    if (out.length >= limit) break
  }
  return out
}
