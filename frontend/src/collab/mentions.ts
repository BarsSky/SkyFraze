import type { TextField } from './text'

/**
 * Поиск упоминаний карточек мира в тексте (docs/entity-links.md §3.2, фаза 2).
 *
 * Чего здесь намеренно нет: морфологии и лемматизации. Падежи задаются алиасами в карточке
 * («Анна», «Анны», «Анне») — словарь русского языка в этом месте даёт ложные связи и требует
 * поддержки, которой у нас нет.
 *
 * Правила, и каждое из них появилось из конкретной ошибки, которую иначе ловит человек:
 *
 *  1. ОСТАЛЬНОЕ СРАВНЕНИЕ — без учёта регистра: «анна» в середине фразы — это та же Анна.
 *  2. Самый длинный алиас первым: в тексте «Анна Сергеевна» не должна давать ещё и «Анну»
 *     внутри себя. В регулярном выражении это порядок альтернатив (длиннее — раньше).
 *  3. Границы — по буквам, цифрам, подчёркиванию И ДЕФИСУ (`\p{L}\p{N}_-`). Дефис в списке
 *     потому, что «Анна-Мария» — другое имя, и «Анна» внутри него упоминанием не является.
 *     Обычный `\b` здесь не годится: для кириллицы он ведёт себя не так, как ждёт человек.
 *  4. Алиас короче двух знаков не ищется: «Я» или «А» находились бы в каждом предложении.
 *     (Сервер такие алиасы и не принимает — правило есть с двух сторон.)
 *  5. Одно место — одно упоминание: одно регулярное выражение на весь текст даёт
 *     непересекающиеся совпадения по построению, а не по нашей аккуратности.
 *
 * Производительность: одно выражение на текст, а не по одному на алиас. Это важно, потому что
 * упоминания пересчитываются на каждую правку кадра, а в проекте бывает сотня кадров.
 */

/** Минимальная длина алиаса для поиска: короче — шум (см. правило 4). */
export const MIN_ALIAS_LENGTH = 2

/** Карточка в том виде, в каком она нужна поиску. */
export interface MentionEntity {
  id: string
  name: string
  aliases: string[]
}

/** Одно найденное упоминание. `from`/`to` — индексы в UTF-16, как у выделения и якорей. */
export interface Mention {
  entityId: string
  entityName: string
  field: TextField
  from: number
  to: number
  /** Как написано в тексте: «Анны», а не «Анна» — по цитате человек понимает, что нашлось. */
  quote: string
}

/** Кадр для поиска: заголовок и текст. */
export interface MentionFrame {
  id: string
  title: string
  body: string
}

/**
 * Поиск всех упоминаний в одном тексте.
 *
 * Возвращает совпадения в порядке появления: так их удобно и показывать, и сопоставлять с
 * текстом.
 */
export function findMentions(
  text: string,
  entities: MentionEntity[],
  field: TextField = 'body',
): Mention[] {
  const pattern = buildPattern(entities)
  if (pattern === null || text === '') return []
  const byAlias = aliasIndex(entities)
  const out: Mention[] = []
  const re = new RegExp(pattern.source, 'giu')
  for (const match of text.matchAll(re)) {
    const quote = match[0]
    const entity = byAlias.get(quote.toLowerCase())
    if (!entity) continue
    const from = match.index ?? 0
    out.push({
      entityId: entity.id,
      entityName: entity.name,
      field,
      from,
      to: from + quote.length,
      quote,
    })
  }
  return out
}

/** Упоминания кадра: заголовок и текст вместе (заголовок идёт первым, у него свой field). */
export function frameMentions(frame: MentionFrame, entities: MentionEntity[]): Mention[] {
  return [
    ...findMentions(frame.title, entities, 'title'),
    ...findMentions(frame.body, entities, 'body'),
  ]
}

/** Сколько РАЗНЫХ кадров содержит каждую карточку и сколько всего упоминаний. */
export interface EntityUsage {
  frames: number
  mentions: number
}

export function entityUsage(
  frames: MentionFrame[],
  entities: MentionEntity[],
): Record<string, EntityUsage> {
  const usage: Record<string, EntityUsage> = {}
  for (const entity of entities) usage[entity.id] = { frames: 0, mentions: 0 }
  for (const frame of frames) {
    const seen = new Set<string>()
    for (const mention of frameMentions(frame, entities)) {
      const row = usage[mention.entityId]
      if (!row) continue
      row.mentions += 1
      seen.add(mention.entityId)
    }
    for (const id of seen) usage[id].frames += 1
  }
  return usage
}

/**
 * Собирает одно регулярное выражение из всех алиасов.
 *
 * `null`, когда искать нечего: пустой паттерн совпал бы с пустой строкой на каждом месте.
 */
function buildPattern(entities: MentionEntity[]): RegExp | null {
  const aliases = collectAliases(entities)
  if (aliases.length === 0) return null
  // Длиннее — раньше: так «Анна Сергеевна» выигрывает у «Анна» на одном и том же месте.
  const alternatives = aliases.map((alias) => escapeRegExp(alias))
  const boundary = '[\\p{L}\\p{N}_-]'
  return new RegExp(`(?<!${boundary})(?:${alternatives.join('|')})(?!${boundary})`, 'iu')
}

/** Все алиасы карточек: имя плюс алиасы, без дублей и без слишком коротких. */
function collectAliases(entities: MentionEntity[]): string[] {
  const seen = new Map<string, string>()
  for (const entity of entities) {
    for (const raw of [entity.name, ...entity.aliases]) {
      const alias = raw.trim()
      if ([...alias].length < MIN_ALIAS_LENGTH) continue
      const key = alias.toLowerCase()
      if (!seen.has(key)) seen.set(key, alias)
    }
  }
  return [...seen.values()].sort((a, b) => b.length - a.length)
}

/** Алиас (в нижнем регистре) → карточка: по совпадению восстанавливаем, кто это. */
function aliasIndex(entities: MentionEntity[]): Map<string, MentionEntity> {
  const index = new Map<string, MentionEntity>()
  for (const entity of entities) {
    for (const raw of [entity.name, ...entity.aliases]) {
      const alias = raw.trim()
      if ([...alias].length < MIN_ALIAS_LENGTH) continue
      const key = alias.toLowerCase()
      if (!index.has(key)) index.set(key, entity)
    }
  }
  return index
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
