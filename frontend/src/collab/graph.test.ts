import { describe, expect, it } from 'vitest'
import { MAX_RING, RAIL_WINDOW, edgeLabel, layoutEgoGraph, type GraphNeighbor } from './graph'

/**
 * Раскладка эго-графа — спецификация правил из обсуждения.
 *
 * Проверяем не «красиво ли», а инварианты, которые видит человек: сосед справа при одной связи,
 * равномерный эллипс при нескольких, «рулетка» с окном при переполнении, и то, что рёбра
 * соединяют центр с соседями, а не что попало.
 */

const center = { id: 'c', name: 'Аня', kind: 'character' }
const neighbor = (index: number, direction: 'out' | 'in' = 'out'): GraphNeighbor => ({
  id: `n${index}`,
  name: `Сосед ${index}`,
  kind: 'place',
  linkId: `l${index}`,
  label: `связь ${index}`,
  direction,
})

describe('layoutEgoGraph', () => {
  it('без связей: только центр, рёбер нет', () => {
    const layout = layoutEgoGraph({ width: 800, height: 600, center, neighbors: [] })
    expect(layout.center.x).toBe(400)
    expect(layout.center.y).toBe(300)
    expect(layout.neighbors).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.mode).toBe('center')
  })

  it('одна связь: сосед справа на той же вертикали', () => {
    const layout = layoutEgoGraph({ width: 800, height: 600, center, neighbors: [neighbor(1)] })
    expect(layout.mode).toBe('center')
    expect(layout.neighbors).toHaveLength(1)
    const only = layout.neighbors[0]
    expect(only.y).toBe(layout.center.y)
    expect(only.x).toBeGreaterThan(layout.center.x)
    // И не за краем холста.
    expect(only.x).toBeLessThanOrEqual(800)
  })

  it('четыре связи: соседи по эллипсу, углы равномерны', () => {
    const neighbors = [1, 2, 3, 4].map((i) => neighbor(i))
    const layout = layoutEgoGraph({ width: 1000, height: 700, center, neighbors })
    expect(layout.neighbors).toHaveLength(4)
    // Первый сосед — сверху (старт −90°).
    expect(layout.neighbors[0].y).toBeCloseTo(layout.center.y - Math.min(700 * 0.36, 210), 5)
    // Противоположные соседи симметричны относительно центра.
    expect(layout.neighbors[2].y).toBeGreaterThan(layout.center.y)
    expect(Math.round(layout.neighbors[0].x)).toBe(Math.round(layout.center.x))
    // Все рёбра — от центра к соседям.
    for (const edge of layout.edges) {
      expect(edge.from.x).toBe(layout.center.x)
      expect(edge.from.y).toBe(layout.center.y)
    }
  })

  it('шесть связей ещё рисуются вокруг центра', () => {
    const neighbors = [1, 2, 3, 4, 5, 6].map((i) => neighbor(i))
    const layout = layoutEgoGraph({ width: 1000, height: 700, center, neighbors })
    expect(MAX_RING).toBe(6)
    expect(layout.mode).toBe('center')
    expect(layout.neighbors).toHaveLength(6)
  })

  it('семь связей — «рулетка»: карточка слева, окно соседей справа', () => {
    const neighbors = [1, 2, 3, 4, 5, 6, 7].map((i) => neighbor(i))
    const layout = layoutEgoGraph({ width: 1000, height: 700, center, neighbors })
    expect(layout.mode).toBe('rail')
    expect(layout.total).toBe(7)
    expect(layout.windowSize).toBe(RAIL_WINDOW)
    expect(layout.neighbors).toHaveLength(RAIL_WINDOW)
    // Центр слева, соседи правее.
    expect(layout.center.x).toBeLessThan(layout.neighbors[0].x)
    // Активен средний в окне.
    const active = layout.neighbors.filter((node) => node.active)
    expect(active).toHaveLength(1)
    expect(active[0].node.id).toBe(neighbors[Math.floor(RAIL_WINDOW / 2)].id)
  })

  it('«рулетка» листается по кругу и начинается с начала', () => {
    const neighbors = [1, 2, 3, 4, 5, 6, 7].map((i) => neighbor(i))
    const first = layoutEgoGraph({ width: 1000, height: 700, center, neighbors, windowStart: 0 })
    const rotated = layoutEgoGraph({ width: 1000, height: 700, center, neighbors, windowStart: 5 })
    expect(first.windowStart).toBe(0)
    expect(first.neighbors[0].node.id).toBe('n1')
    // Пять — это уже «последние»: окно переходит через конец по кругу.
    expect(rotated.windowStart).toBe(5)
    expect(rotated.neighbors.map((n) => n.node.id)).toEqual(['n6', 'n7', 'n1', 'n2', 'n3'])
  })

  it('подпись ребра показывает направление', () => {
    const layout = layoutEgoGraph({
      width: 800,
      height: 600,
      center,
      neighbors: [neighbor(1, 'in'), neighbor(2, 'out')],
    })
    const labels = layout.edges.map(edgeLabel)
    expect(labels).toContain('← связь 1')
    expect(labels).toContain('→ связь 2')
  })
})
