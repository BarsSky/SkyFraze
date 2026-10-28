import { describe, expect, it } from 'vitest'
import { buildNeighborhood } from './neighborhood'
import type { EntityLink } from '../api/entities'
import type { GraphNode } from './graph'

/**
 * Окрестность по уровням (0.100.0): «глубже» без верхней границы.
 *
 * Решение из отчёта: глубина без потолка. Поэтому проверяем не «до третьего уровня», а поведение
 * обхода: ближайший уровень забирает карточку себе, дальше она не повторяется, а «глубже» имеет
 * смысл ровно тогда, когда обход упёрся в непоказанных соседей.
 */

const node = (id: string, name = id): GraphNode => ({ id, name, kind: 'character' })

const link = (from: string, to: string, label = 'живёт на'): EntityLink => ({
  id: `${from}-${to}-${label}`,
  from_entity: from,
  to_entity: to,
  label,
  created_at: '2026-10-27T10:00:00Z',
})

// Цепочка a — b — c — d и отдельная ветка a — e.
const nodes = [node('a'), node('b'), node('c'), node('d'), node('e')]
const links = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('a', 'e')]

const names = (level: { nodes: GraphNode[] }) => level.nodes.map((item) => item.id).sort()

describe('buildNeighborhood', () => {
  it('уровень 1 — прямые соседи, и их не больше, чем есть связей', () => {
    const result = buildNeighborhood('a', links, nodes, 1)
    expect(result.levels).toHaveLength(1)
    expect(names(result.levels[0])).toEqual(['b', 'e'])
    expect(result.total).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('уровень 2 — соседи соседей, без повторов уже показанных', () => {
    const result = buildNeighborhood('a', links, nodes, 2)
    expect(result.levels).toHaveLength(2)
    expect(names(result.levels[1])).toEqual(['c'])
    // «b» и «e» на втором уровне не повторяются — иначе уровень раздувался бы видимым.
    expect(result.total).toBe(3)
  })

  it('без верхней границы обход идёт, пока есть карточки, и упирается в конец цепочки', () => {
    const all = buildNeighborhood('a', links, nodes, Number.POSITIVE_INFINITY)
    expect(all.levels.map((level) => level.level)).toEqual([1, 2, 3])
    expect(names(all.levels[2])).toEqual(['d'])
    expect(all.total).toBe(4)
    // Дальше идти некуда: d — конец цепочки.
    expect(all.truncated).toBe(false)
  })

  it('карточка без связей: уровней нет вообще, «глубже» бессмысленно', () => {
    const lonely = buildNeighborhood('a', [], nodes, Number.POSITIVE_INFINITY)
    expect(lonely.levels).toEqual([])
    expect(lonely.total).toBe(0)
    expect(lonely.truncated).toBe(false)
  })

  it('связь в обе стороны считается соседством, а не направлением', () => {
    const reversed = buildNeighborhood('d', links, nodes, 1)
    expect(names(reversed.levels[0])).toEqual(['c'])
  })

  it('обрывки данных не ломают обход: связь на несуществующую карточку игнорируется', () => {
    const withGhost = buildNeighborhood('a', [...links, link('a', 'ghost')], nodes, 2)
    expect(withGhost.levels[0].nodes.map((item) => item.id).sort()).toEqual(['b', 'e'])
    expect(withGhost.total).toBe(3)
  })
})
