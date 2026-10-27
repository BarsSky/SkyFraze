import { describe, expect, it } from 'vitest'
import { MAX_RING, RAIL_WINDOW, edgeLabel, edgePieces, layoutEgoGraph, type GraphNeighbor } from './graph'

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

  /**
   * Подпись стоит В РАЗРЫВЕ линии (0.84.0): подпись на середине ребра, без подъёма над линией —
   * компонент центрирует текст по линии (`dominant-baseline: middle`) и вырезает под него
   * промежуток. Тест держит это соглашение: поднимешь `labelAt` обратно над линией — разрыв
   * окажется не под текстом.
   */
  it('подпись ребра — ровно на середине линии, а не над ней', () => {
    const layout = layoutEgoGraph({ width: 800, height: 600, center, neighbors: [neighbor(1)] })
    const edge = layout.edges[0]
    expect(edge.labelAt.x).toBeCloseTo((edge.from.x + edge.to.x) / 2, 6)
    expect(edge.labelAt.y).toBeCloseTo((edge.from.y + edge.to.y) / 2, 6)
  })
})

/**
 * Разрыв в линии под подписью (0.84.0).
 *
 * Заказ: «сделать разрыв в линии где идёт подпись». Геометрия вынесена из компонента, чтобы
 * проверять её числами, а не глазами: разрыв по центру, достаточно широкий под текст, но не
 * съедающий ребро целиком.
 */
describe('edgePieces — линия с разрывом под подписью', () => {
  const horizontal = { from: { x: 0, y: 100 }, to: { x: 400, y: 100 } }

  it('горизонтальная линия рвётся по центру, обе половины на месте', () => {
    const { before, after } = edgePieces(horizontal, 10)
    expect(before.x1).toBe(0)
    expect(before.x2).toBeLessThan(200)
    expect(after.x1).toBeGreaterThan(200)
    expect(after.x2).toBe(400)
    // Симметрия: разрыв центрирован.
    expect(200 - before.x2).toBeCloseTo(after.x1 - 200, 6)
    expect(before.y1).toBe(100)
    expect(after.y2).toBe(100)
  })

  it('длинная подпись даёт более широкий разрыв', () => {
    const narrow = edgePieces(horizontal, 4)
    const wide = edgePieces(horizontal, 20)
    expect(wide.after.x1 - wide.before.x2).toBeGreaterThan(narrow.after.x1 - narrow.before.x2)
  })

  it('разрыв не съедает ребро целиком: короткая связь остаётся видимой', () => {
    const short = { from: { x: 0, y: 0 }, to: { x: 40, y: 0 } }
    const { before, after } = edgePieces(short, 22)
    expect(before.x2).toBeGreaterThanOrEqual(0)
    expect(before.x2).toBeLessThan(after.x1)
    // Не больше 60%: по 20% линии остаётся с каждой стороны.
    expect(before.x2).toBeCloseTo(40 * 0.2, 6)
  })

  /**
   * Угол учитывается по габаритам текста, а не «на глаз»: подпись горизонтальная, поэтому у
   * вертикальной связи она ложится ПОПЕРЁК линии и разрыв нужен всего в высоту строки, а у
   * горизонтальной — во всю ширину текста.
   */
  it('разрыв зависит от угла: горизонтальной связи нужен широкий, вертикальной — узкий', () => {
    const vertical = { from: { x: 100, y: 0 }, to: { x: 100, y: 400 } }
    const steep = edgePieces(vertical, 10)
    const flat = edgePieces(horizontal, 10)
    const steepGap = steep.after.y1 - steep.before.y2
    const flatGap = flat.after.x1 - flat.before.x2
    expect(flatGap).toBeCloseTo(10 * 6.3 + 14, 6)
    expect(steepGap).toBeCloseTo(12 + 14, 6)
    expect(steepGap).toBeLessThan(flatGap)
    // И всё равно не больше 60% длины.
    expect(steepGap).toBeLessThanOrEqual(400 * 0.6 + 0.001)
  })

  it('вырожденное ребро не даёт линии из NaN', () => {
    const { before, after } = edgePieces({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 } }, 10)
    expect(before).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5 })
    expect(after).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5 })
  })
})
