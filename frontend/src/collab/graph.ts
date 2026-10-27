/**
 * Раскладка эго-графа: карточка в центре и её связи вокруг (0.75.0).
 *
 * Почему эго-граф, а не весь граф проекта: при тридцати карточках «весь граф» — клубок, который
 * нечитаем ни на телефоне, ни на ноутбуке, а задача этого окна — переход «от карточки к
 * карточке». Поэтому рисуем окружение ОДНОЙ карточки, а центром становится та, на которую
 * кликнули.
 *
 * Правила раскладки (из обсуждения с заказчиком):
 *   · одна связь  — сосед справа, по центру вертикали;
 *   · 2–6 связей  — соседи по эллипсу, углы равномерно;
 *   · больше шести — карточка прижата к левому краю, соседи идут вертикальной «рулеткой»:
 *     видно окно из нескольких, остальные подъезжают при листании.
 *
 * Вся математика здесь и без DOM — чтобы её можно было проверить тестами, а не глазами.
 */

/** Что нужно знать про карточку для рисования. */
export interface GraphNode {
  id: string
  name: string
  kind: string
}

/** Сосед: карточка и подпись связи (направление уже учтено вызывающим). */
export interface GraphNeighbor extends GraphNode {
  linkId: string
  label: string
  direction: 'out' | 'in'
}

/** Узел на холсте. */
export interface PositionedNode {
  node: GraphNode
  x: number
  y: number
  /** Соседи-«рулетка» помечены: активный рисуется крупнее. */
  active?: boolean
}

/** Ребро: от центра к соседу, с подписью посередине. */
export interface GraphEdge {
  linkId: string
  label: string
  direction: 'out' | 'in'
  targetId: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  labelAt: { x: number; y: number }
}

export interface GraphLayout {
  /** «центр» — соседи вокруг; «рулетка» — карточка слева, соседи в столбик. */
  mode: 'center' | 'rail'
  center: PositionedNode
  neighbors: PositionedNode[]
  edges: GraphEdge[]
  /** Для «рулетки»: сколько соседей всего и с какого показано окно. */
  total: number
  windowStart: number
  windowSize: number
}

/** Сколько соседей рисуем вокруг центра, прежде чем перейти к «рулетке». */
export const MAX_RING = 6
/** Сколько соседей видно в окне «рулетки». */
export const RAIL_WINDOW = 5

export interface LayoutInput {
  width: number
  height: number
  center: GraphNode
  neighbors: GraphNeighbor[]
  /** С какого соседа начинается окно «рулетки» (листание). */
  windowStart?: number
}

/**
 * Считает раскладку.
 *
 * `width`/`height` — размер холста в пикселях. Радиус эллипса — доля от размера, но не больше
 * предела: на широком экране соседи не должны разъезжаться по краям, на узком — не
 * наезжать на центр.
 */
export function layoutEgoGraph(input: LayoutInput): GraphLayout {
  const width = Math.max(1, input.width)
  const height = Math.max(1, input.height)
  const total = input.neighbors.length

  if (total > MAX_RING) {
    return railLayout(width, height, input.center, input.neighbors, input.windowStart ?? 0)
  }

  const center: PositionedNode = { node: input.center, x: width / 2, y: height / 2 }
  if (total === 0) {
    return { mode: 'center', center, neighbors: [], edges: [], total: 0, windowStart: 0, windowSize: 0 }
  }
  if (total === 1) {
    // Один сосед — справа от центра: так связь читается как «ведёт к…», а не «висит сверху».
    const x = Math.min(width - 60, center.x + Math.max(90, width * 0.28))
    const node: PositionedNode = { node: input.neighbors[0], x, y: center.y }
    return {
      mode: 'center',
      center,
      neighbors: [node],
      edges: [edgeFor(input.neighbors[0], center, node)],
      total: 1,
      windowStart: 0,
      windowSize: 1,
    }
  }

  const radiusX = Math.min(width * 0.36, 260)
  const radiusY = Math.min(height * 0.36, 210)
  const neighbors: PositionedNode[] = []
  const edges: GraphEdge[] = []
  input.neighbors.forEach((neighbor, index) => {
    // Старт сверху (−90°): первая связь читается как «главная», а не уходит вбок.
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total
    const node: PositionedNode = {
      node: neighbor,
      x: center.x + radiusX * Math.cos(angle),
      y: center.y + radiusY * Math.sin(angle),
    }
    neighbors.push(node)
    edges.push(edgeFor(neighbor, center, node))
  })
  return {
    mode: 'center',
    center,
    neighbors,
    edges,
    total,
    windowStart: 0,
    windowSize: total,
  }
}

/**
 * «Рулетка»: карточка у левого края, соседи столбиком.
 *
 * Окно из `RAIL_WINDOW` соседей — компромисс: шесть строк ещё читаются на телефоне, а листать
 * одну за одной неудобно. `windowStart` зациклен, чтобы листание шло по кругу.
 */
function railLayout(
  width: number,
  height: number,
  centerNode: GraphNode,
  neighbors: GraphNeighbor[],
  rawStart: number,
): GraphLayout {
  const total = neighbors.length
  const start = ((rawStart % total) + total) % total
  const center: PositionedNode = { node: centerNode, x: Math.min(110, width * 0.3), y: height / 2 }
  const visible: PositionedNode[] = []
  const edges: GraphEdge[] = []
  const size = Math.min(RAIL_WINDOW, total)
  const step = height / (size + 1)
  for (let i = 0; i < size; i += 1) {
    const neighbor = neighbors[(start + i) % total]
    const y = step * (i + 1)
    const node: PositionedNode = {
      node: neighbor,
      x: width - Math.min(120, width * 0.32),
      y,
      active: i === Math.floor(size / 2),
    }
    visible.push(node)
    edges.push(edgeFor(neighbor, center, node))
  }
  return {
    mode: 'rail',
    center,
    neighbors: visible,
    edges,
    total,
    windowStart: start,
    windowSize: size,
  }
}

/** Ребро с подписью посередине (чуть выше линии, чтобы не читать по буквам). */
function edgeFor(neighbor: GraphNeighbor, center: PositionedNode, target: PositionedNode): GraphEdge {
  return {
    linkId: neighbor.linkId,
    label: neighbor.label,
    direction: neighbor.direction,
    targetId: neighbor.id,
    from: { x: center.x, y: center.y },
    to: { x: target.x, y: target.y },
    labelAt: { x: (center.x + target.x) / 2, y: (center.y + target.y) / 2 - 6 },
  }
}

/** Подпись ребра: направление + подпись связи. */
export function edgeLabel(edge: { label: string; direction: 'out' | 'in' }): string {
  return edge.direction === 'out' ? `→ ${edge.label}` : `← ${edge.label}`
}
