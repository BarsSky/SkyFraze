/**
 * Перемещение событий в дереве редактора.
 *
 * Дерево живёт в плоском списке: порядок массива = порядок отображения
 * (соседи идут в порядке появления), `parentId` задаёт уровень. Поэтому перенос
 * поддерева — это один сдвиг в массиве плюс смена `parentId` у его корня:
 * потомки остаются на своих местах и «приезжают» под нового родителя сами.
 *
 * Модуль чистый: ни Yjs, ни DOM — только массивы объектов, поэтому проверяется
 * без браузера. Y-обёртка (`yMoveSubtree` в `yprovider.ts`) использует ту же
 * проверку и тот же расчёт позиции, применяя результат к Y.Array.
 *
 * Запрещённые ходы (возвращаем `null`, не молчаливый no-op):
 *  - неизвестный id источника или цели;
 *  - перенос в себя;
 *  - перенос в собственного потомка (цикл);
 *  - выход за `maxDepth` с учётом высоты переносимого поддерева.
 */
import { buildEventTree, DEFAULT_MAX_DEPTH, type EventLike, type EventTreeNode } from './eventTree'

/** Куда кладём: перед целью, после цели или в конец её детей. */
export type DropPlace = 'before' | 'after' | 'inside'

/** Почему ход запрещён. */
export type MoveReject =
  | 'unknown-source'
  | 'unknown-target'
  | 'self'
  | 'cycle'
  | 'depth'

export interface MovePlan {
  /** Новый родитель переносимого события (`null` — верхний уровень). */
  parentId: string | null
  /** Уровень (`depth`) переносимого события после переноса. */
  depth: number
  /** Индекс вставки в массиве, из которого переносимый элемент уже удалён. */
  index: number
}

export type MoveCheck =
  | { ok: true; plan: MovePlan }
  | { ok: false; reason: MoveReject }

/** id → первое вхождение. Дубликаты id (битые данные) дальше не размножаем. */
function indexById<T extends EventLike>(items: T[]): Map<string, T> {
  const byId = new Map<string, T>()
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return byId
}

/**
 * Нормализованные связи: сироты, циклы и слишком глубокие узлы `buildEventTree`
 * уже привёл к дереву, которое видит человек. Проверять ход надо по нему же.
 */
function normalizedLinks<T extends EventLike>(
  items: T[],
  maxDepth: number,
): Map<string, { parentId: string | null; depth: number }> {
  const links = new Map<string, { parentId: string | null; depth: number }>()
  const walk = (node: EventTreeNode<T>, parentId: string | null) => {
    links.set(node.item.id, { parentId, depth: node.depth })
    for (const child of node.children) walk(child, node.item.id)
  }
  for (const root of buildEventTree(items, maxDepth)) walk(root, null)
  return links
}

/** Прямые дети по «сырым» связям: высота поддерева не зависит от нормализации. */
function rawChildren<T extends EventLike>(items: T[]): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const item of items) {
    if (!item || !item.parentId || item.parentId === item.id) continue
    const list = children.get(item.parentId) ?? []
    list.push(item.id)
    children.set(item.parentId, list)
  }
  return children
}

/** Высота поддерева в рёбрах (0 — потомков нет). Защита от циклов в данных. */
function subtreeHeight(id: string, children: Map<string, string[]>): number {
  let height = 0
  const seen = new Set<string>([id])
  let level: string[] = [id]
  while (level.length > 0) {
    const next: string[] = []
    for (const current of level) {
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        next.push(child)
      }
    }
    if (next.length === 0) break
    height++
    level = next
  }
  return height
}

/** Цель — сам переносимый узел или его потомок? */
function isInsideSubtree(
  candidate: string,
  root: string,
  links: Map<string, { parentId: string | null }>,
): boolean {
  const seen = new Set<string>()
  let cursor: string | null = candidate
  while (cursor) {
    if (cursor === root) return true
    if (seen.has(cursor)) return false // в исходных данных уже цикл
    seen.add(cursor)
    cursor = links.get(cursor)?.parentId ?? null
  }
  return false
}

/**
 * Проверяет ход и считает, куда именно встанет переносимое событие.
 * `targetId === null` — в конец верхнего уровня (поле `place` тогда не важно).
 */
export function checkMove<T extends EventLike>(
  items: T[],
  id: string,
  targetId: string | null,
  place: DropPlace,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): MoveCheck {
  const byId = indexById(items)
  if (!byId.has(id)) return { ok: false, reason: 'unknown-source' }
  if (targetId !== null) {
    if (!byId.has(targetId)) return { ok: false, reason: 'unknown-target' }
    if (targetId === id) return { ok: false, reason: 'self' }
  }

  const links = normalizedLinks(items, maxDepth)
  if (targetId !== null && isInsideSubtree(targetId, id, links)) {
    return { ok: false, reason: 'cycle' }
  }

  const parentId =
    targetId === null ? null : place === 'inside' ? targetId : links.get(targetId)?.parentId ?? null
  const depth = parentId === null ? 0 : (links.get(parentId)?.depth ?? 0) + 1
  const height = subtreeHeight(id, rawChildren(items))
  if (depth + height > maxDepth) return { ok: false, reason: 'depth' }

  const from = items.findIndex((item) => item.id === id)
  if (from < 0) return { ok: false, reason: 'unknown-source' }
  const without = [...items.slice(0, from), ...items.slice(from + 1)]

  let index: number
  if (targetId === null) {
    index = without.length
  } else if (place === 'inside') {
    // В конец детей цели: после самой цели и после всех её прямых детей,
    // где бы они ни лежали в массиве.
    let last = without.findIndex((item) => item.id === targetId)
    for (let i = 0; i < without.length; i++) {
      if (without[i].parentId === targetId && i > last) last = i
    }
    index = last + 1
  } else {
    const at = without.findIndex((item) => item.id === targetId)
    index = place === 'before' ? at : at + 1
  }

  return { ok: true, plan: { parentId, depth, index } }
}

/**
 * Возвращает НОВЫЙ массив с перенесённым событием или `null`, если ход запрещён.
 * Входной массив и его объекты не мутируются; у переносимого события берётся
 * копия с новым `parentId`, остальные элементы переиспользуются.
 */
export function moveEvent<T extends EventLike>(
  items: T[],
  id: string,
  targetId: string | null,
  place: DropPlace,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): T[] | null {
  const check = checkMove(items, id, targetId, place, maxDepth)
  if (!check.ok) return null
  const from = items.findIndex((item) => item.id === id)
  if (from < 0) return null

  const without = [...items.slice(0, from), ...items.slice(from + 1)]
  const moved = { ...items[from], parentId: check.plan.parentId } as T
  const at = Math.max(0, Math.min(without.length, check.plan.index))
  return [...without.slice(0, at), moved, ...without.slice(at)]
}
