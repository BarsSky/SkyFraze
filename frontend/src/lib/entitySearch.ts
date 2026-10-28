import type { ProjectEntity, EntityLink } from '../api/entities'
import { typeTitle, type EntityType } from '../api/entityTypes'

/**
 * Поиск по всем меткам карточки (0.100.0).
 *
 * Зачем отдельный индекс. В графе поиск шёл по `entity.name.includes(...)`: алиасы («Анна», «Аня»)
 * в нём не участвовали, вид — тоже, а подписи связей («живёт на») не участвовали тем более. В
 * проекте, где у карточки три написания имени, поиск по «Анна» не находил «Аню» — и это читалось
 * как «поиск не работает».
 *
 * Метки: **имя, все алиасы, вид, подписи связей карточки**. Индекс строится один раз на список
 * карточек (см. `buildEntityIndex`) и обновляется при их изменении: искать по 30 карточкам и по 300 —
 * это два разных по скорости поведения, а `includes` по каждому запросу одинаково дешёв только на
 * малых числах.
 */

/** Какая именно метка совпала — по ней интерфейс объясняет, почему карточка в выдаче. */
export type MatchSource = 'name' | 'alias' | 'kind' | 'link'

export interface EntitySearchHit {
  entity: ProjectEntity
  /** Что совпало: «имя», «алиас «Аня»», «вид «Место»», «связь «живёт на»». */
  source: MatchSource
  /** Совпавшая строка: по ней считается подсветка и подпись в подсказке. */
  matched: string
  /** Индекс совпадения в `matched` и его длина — для подсветки. */
  at: number
  length: number
}

interface IndexEntry {
  entity: ProjectEntity
  /** Все метки карточки: нормализованная строка → исходное написание и источник. */
  labels: Array<{ text: string; source: MatchSource }>
}

export interface EntityIndex {
  entries: IndexEntry[]
}

/** Приводит строку к виду, по которому ищут: нижний регистр, ё → е, схлопнутые пробелы. */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/**
 * Строит индекс меток.
 *
 * Подписи связей берутся у самой карточки в обе стороны: «живёт на» стоит на связи Ани с Землёй, и
 * по слову «живёт» человек ждёт увидеть Аню — она и есть та, о ком связь говорит.
 */
export function buildEntityIndex(
  entities: ProjectEntity[],
  links: EntityLink[],
  types: EntityType[] = [],
): EntityIndex {
  const labelsByEntity = new Map<string, string[]>()
  for (const link of links) {
    for (const id of [link.from_entity, link.to_entity]) {
      const list = labelsByEntity.get(id)
      if (list) list.push(link.label)
      else labelsByEntity.set(id, [link.label])
    }
  }

  const entries = entities.map((entity) => {
    const seen = new Set<string>()
    const labels: IndexEntry['labels'] = []
    const push = (text: string, source: MatchSource) => {
      const trimmed = text.trim()
      if (trimmed === '') return
      const key = normalizeForSearch(trimmed)
      if (seen.has(key)) return
      seen.add(key)
      labels.push({ text: trimmed, source })
    }
    push(entity.name, 'name')
    for (const alias of entity.aliases) push(alias, 'alias')
    push(typeTitle(types, entity.kind), 'kind')
    for (const label of labelsByEntity.get(entity.id) ?? []) push(label, 'link')
    return { entity, labels }
  })

  return { entries }
}

/**
 * Ищет по индексу.
 *
 * Порядок важен: имя, потом алиас, потом вид, потом подпись связи. Человек, набравший «ан», ждёт
 * сверху «Аню», а не «Ангарск» из подписи связи; внутри одного источника — по началу строки, затем
 * по вхождению (начало читается как более точное совпадение).
 */
export function searchEntities(index: EntityIndex, query: string, limit = 8): EntitySearchHit[] {
  const needle = normalizeForSearch(query)
  if (needle === '') return []

  const hits: Array<EntitySearchHit & { rank: number; startsWith: boolean }> = []
  for (const entry of index.entries) {
    let best: (typeof hits)[number] | null = null
    for (const label of entry.labels) {
      const haystack = normalizeForSearch(label.text)
      const at = haystack.indexOf(needle)
      if (at < 0) continue
      const rank = sourceRank(label.source)
      const startsWith = at === 0
      const candidate = {
        entity: entry.entity,
        source: label.source,
        matched: label.text,
        at,
        length: needle.length,
        rank,
        startsWith,
      }
      if (best === null || compareHits(candidate, best) < 0) best = candidate
    }
    if (best !== null) hits.push(best)
  }

  hits.sort(compareHits)
  return hits.slice(0, Math.max(1, limit)).map(({ rank: _rank, startsWith: _startsWith, ...hit }) => hit)
}

function sourceRank(source: MatchSource): number {
  switch (source) {
    case 'name':
      return 0
    case 'alias':
      return 1
    case 'kind':
      return 2
    default:
      return 3
  }
}

function compareHits(
  a: { rank: number; startsWith: boolean; matched: string },
  b: { rank: number; startsWith: boolean; matched: string },
): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.startsWith !== b.startsWith) return a.startsWith ? -1 : 1
  return a.matched.localeCompare(b.matched, 'ru')
}
