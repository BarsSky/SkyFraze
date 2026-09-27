/**
 * Нормализация плоского списка событий в дерево.
 *
 * Источник истины — CRDT (Y.Array<Y.Map>), где связь задаётся полем `parent_id`.
 * Данные приходят из ненадёжного источника (клиентский CRDT, старые снапшоты,
 * ручные скрипты), поэтому перед отрисовкой дерево нормализуется:
 *
 *  - сирота (parent_id ссылается на несуществующее событие) → становится корнем,
 *    а не исчезает из таймлайна;
 *  - цикл (A → B → A) → разрывается, узлы поднимаются в корень;
 *  - самоссылка (parent_id === id) → корень;
 *  - дубликаты id → остаётся первое вхождение (порядок массива = порядок в UI);
 *  - глубина больше `maxDepth` → узел поднимается в корень (данные не теряются);
 *  - порядок соседей сохраняется таким, каким он пришёл из массива.
 *
 * Функция чистая: НЕ мутирует входные объекты.
 */

export interface EventLike {
  id: string
  parentId: string | null
}

export interface EventTreeNode<T extends EventLike> {
  item: T
  /** 0 — корень; растёт на 1 на каждом уровне вложенности */
  depth: number
  children: Array<EventTreeNode<T>>
}

export const DEFAULT_MAX_DEPTH = 4

export function buildEventTree<T extends EventLike>(
  items: T[],
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Array<EventTreeNode<T>> {
  const byId = new Map<string, T>()
  const order: T[] = []
  for (const item of items) {
    if (!item || !item.id || byId.has(item.id)) continue
    byId.set(item.id, item)
    order.push(item)
  }

  const rawParentOf = (item: T): T | null => {
    const pid = item.parentId
    if (!pid || pid === item.id) return null
    return byId.get(pid) ?? null
  }

  // 1. Эффективный родитель: сироты и участники циклов становятся корнями.
  const effectiveParent = new Map<string, string | null>()
  for (const item of order) {
    let parent = rawParentOf(item)
    let resolved: string | null = parent ? parent.id : null
    const seen = new Set<string>([item.id])
    let cursor: T | null = parent
    while (cursor) {
      if (seen.has(cursor.id)) {
        resolved = null // цикл — рвём связь
        break
      }
      seen.add(cursor.id)
      cursor = rawParentOf(cursor)
    }
    effectiveParent.set(item.id, resolved)
  }

  // 2. Глубина с мемоизацией (циклы уже разорваны, рекурсия конечна).
  const depthOf = new Map<string, number>()
  const computeDepth = (item: T): number => {
    const memo = depthOf.get(item.id)
    if (memo !== undefined) return memo
    depthOf.set(item.id, 0) // защита от неожиданных циклов
    const pid = effectiveParent.get(item.id) ?? null
    const parent = pid ? byId.get(pid) : undefined
    const depth = parent ? computeDepth(parent) + 1 : 0
    depthOf.set(item.id, depth)
    return depth
  }
  for (const item of order) computeDepth(item)

  // 3. Слишком глубокие узлы поднимаем в корень: лучше плоско, чем невидимо.
  if (maxDepth >= 0) {
    for (const item of order) {
      if ((depthOf.get(item.id) ?? 0) > maxDepth) effectiveParent.set(item.id, null)
    }
  }

  // 4. Сборка дерева в исходном порядке.
  const nodes = new Map<string, EventTreeNode<T>>()
  for (const item of order) nodes.set(item.id, { item, depth: 0, children: [] })

  const roots: Array<EventTreeNode<T>> = []
  for (const item of order) {
    const node = nodes.get(item.id)
    if (!node) continue
    const pid = effectiveParent.get(item.id) ?? null
    const parent = pid ? nodes.get(pid) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // 5. Финальная простановка depth по фактической форме дерева.
  const assignDepth = (node: EventTreeNode<T>, depth: number) => {
    node.depth = depth
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  for (const root of roots) assignDepth(root, 0)

  return roots
}

/** Обход дерева в порядке отображения (pre-order). */
export function flattenTree<T extends EventLike>(roots: Array<EventTreeNode<T>>): Array<EventTreeNode<T>> {
  const out: Array<EventTreeNode<T>> = []
  const walk = (node: EventTreeNode<T>) => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

/** Все потомки узла (без самого узла). */
export function descendantsOf<T extends EventLike>(node: EventTreeNode<T>): Array<EventTreeNode<T>> {
  const out: Array<EventTreeNode<T>> = []
  const walk = (n: EventTreeNode<T>) => {
    for (const child of n.children) {
      out.push(child)
      walk(child)
    }
  }
  walk(node)
  return out
}
