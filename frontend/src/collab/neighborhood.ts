import type { EntityLink } from '../api/entities'
import type { GraphNode } from './graph'

/**
 * Окрестность карточки по уровням (0.100.0) — «погружение до конечного звена».
 *
 * Зачем. Эго-граф показывает только прямых соседей: у карточки с одной связью дальше некуда идти, а
 * у «главного героя» соседей двадцать, и что за ними — не видно. Здесь считается обход в ширину:
 * уровень 1 — прямые соседи, уровень 2 — соседи соседей и так далее **без верхней границы**, пока
 * обход не исчерпает проект. Ограничение — не глубина, а данные: когда новых карточек нет, уровень
 * не появляется.
 *
 * `truncated` отвечает на вопрос «есть ли ещё глубже»: если на последнем уровне обход упёрся в
 * карточки, чьи соседи ещё не показаны, — значит, «глубже» имеет смысл. Это важнее, чем кажется:
 * кнопка «ещё уровень», которая ничего не добавляет, выглядит сломанной.
 */
export interface NeighborhoodLevel {
  /** 1 — прямые соседи, 2 — соседи соседей, … */
  level: number
  nodes: GraphNode[]
}

export interface Neighborhood {
  levels: NeighborhoodLevel[]
  /** Сколько карточек во всех уровнях, не считая центра. */
  total: number
  /** Есть ли что показать глубже (на последнем уровне остались непоказанные соседи). */
  truncated: boolean
}

/**
 * Обход в ширину от карточки.
 *
 * `depth` — сколько уровней показать; `Infinity` или большое число — «всё, что связано с центром».
 * Повторно карточка не появляется: она попадает на БЛИЖАЙШИЙ уровень, иначе «уровень 2» раздувался
 * бы теми, кого уже видно на первом.
 */
export function buildNeighborhood(
  centerId: string,
  links: EntityLink[],
  nodes: GraphNode[],
  depth: number,
): Neighborhood {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const adjacency = new Map<string, Set<string>>()
  const connect = (from: string, to: string) => {
    const set = adjacency.get(from)
    if (set) set.add(to)
    else adjacency.set(from, new Set([to]))
  }
  for (const link of links) {
    connect(link.from_entity, link.to_entity)
    connect(link.to_entity, link.from_entity)
  }

  const seen = new Set<string>([centerId])
  const levels: NeighborhoodLevel[] = []
  let frontier = [centerId]
  const maxLevel = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : Number.MAX_SAFE_INTEGER

  for (let level = 1; level <= maxLevel && frontier.length > 0; level += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighborId of adjacency.get(id) ?? []) {
        if (seen.has(neighborId)) continue
        if (!byId.has(neighborId)) continue
        seen.add(neighborId)
        next.push(neighborId)
      }
    }
    if (next.length === 0) break
    levels.push({ level, nodes: next.map((id) => byId.get(id) as GraphNode) })
    frontier = next
  }

  // «Есть ли глубже»: у последнего уровня остались соседи, которых мы не показали.
  let truncated = false
  const last = levels[levels.length - 1]
  if (last) {
    for (const node of last.nodes) {
      for (const neighborId of adjacency.get(node.id) ?? []) {
        if (!seen.has(neighborId) && byId.has(neighborId)) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }
  }

  return {
    levels,
    total: levels.reduce((sum, item) => sum + item.nodes.length, 0),
    truncated,
  }
}
