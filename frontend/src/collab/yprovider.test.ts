import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { buildEventTree, flattenTree } from './eventTree'
import {
  yAddEvent,
  yDeleteEvent,
  yEnsureEventIds,
  yEventId,
  yEventParentId,
  yMoveEvent,
  yMoveSubtree,
} from './yprovider'

function makeArray() {
  const doc = new Y.Doc()
  return { doc, arr: doc.getArray<Y.Map<unknown>>('events') }
}

const ids = (arr: Y.Array<Y.Map<unknown>>) => arr.toArray().map((m) => m.get('id') as string)

describe('yprovider — иерархия событий', () => {
  it('yAddEvent пишет parent_id и сохраняет обратную совместимость сигнатуры', () => {
    const { arr } = makeArray()
    const parent = yAddEvent(arr, 'Глава', 'текст')
    const child = yAddEvent(arr, 'Подсобытие', 'детали', { parentId: parent.get('id') as string })
    expect(arr.length).toBe(2)
    expect(yEventParentId(child)).toBe(parent.get('id'))
    expect(yEventParentId(parent)).toBeNull()
  })

  it('yAddEvent поддерживает вставку по позиции', () => {
    const { arr } = makeArray()
    yAddEvent(arr, 'A')
    const b = yAddEvent(arr, 'B')
    yAddEvent(arr, 'C', '', { position: 0 })
    expect(arr.get(0).get('title')).toBe('C')
    expect(arr.toArray().includes(b)).toBe(true)
  })

  it('yEventId выдаёт стабильный id и дописывает отсутствующий', () => {
    const { arr } = makeArray()
    const m = new Y.Map<unknown>()
    arr.push([m])
    const first = yEventId(m)
    expect(first).toBeTruthy()
    expect(yEventId(m)).toBe(first)
  })

  it('yEnsureEventIds восстанавливает отсутствующие id', () => {
    const { arr } = makeArray()
    arr.push([new Y.Map<unknown>(), new Y.Map<unknown>()])
    expect(yEnsureEventIds(arr)).toBe(2)
    expect(yEnsureEventIds(arr)).toBe(0)
    expect(ids(arr).every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  })

  it('yDeleteEvent удаляет событие вместе со всеми потомками', () => {
    const { arr } = makeArray()
    const root = yAddEvent(arr, 'root')
    const mid = yAddEvent(arr, 'mid', '', { parentId: root.get('id') as string })
    const leaf = yAddEvent(arr, 'leaf', '', { parentId: mid.get('id') as string })
    const other = yAddEvent(arr, 'other')

    const removed = yDeleteEvent(arr, root.get('id') as string)
    expect(removed).toBe(3)
    expect(ids(arr)).toEqual([other.get('id')])
    expect(arr.toArray().some((m) => m.get('id') === leaf.get('id'))).toBe(false)
  })

  it('yDeleteEvent не трогает соседей и возвращает 0 для неизвестного id', () => {
    const { arr } = makeArray()
    const a = yAddEvent(arr, 'a')
    const b = yAddEvent(arr, 'b')
    expect(yDeleteEvent(arr, 'нет-такого')).toBe(0)
    expect(ids(arr)).toEqual([a.get('id'), b.get('id')])
  })

  it('yMoveEvent меняет родителя и умеет возвращать в корень', () => {
    const { arr } = makeArray()
    const root = yAddEvent(arr, 'root')
    const child = yAddEvent(arr, 'child')
    expect(yMoveEvent(arr, child.get('id') as string, root.get('id') as string)).toBe(true)
    expect(yEventParentId(child)).toBe(root.get('id'))
    expect(yMoveEvent(arr, child.get('id') as string, null)).toBe(true)
    expect(yEventParentId(child)).toBeNull()
  })

  it('yMoveEvent запрещает перенос на себя и в собственного потомка', () => {
    const { arr } = makeArray()
    const root = yAddEvent(arr, 'root')
    const mid = yAddEvent(arr, 'mid', '', { parentId: root.get('id') as string })
    const rootId = root.get('id') as string
    const midId = mid.get('id') as string

    expect(yMoveEvent(arr, rootId, rootId)).toBe(false)
    expect(yMoveEvent(arr, rootId, midId)).toBe(false)
    expect(yEventParentId(root)).toBeNull()
    expect(yEventParentId(mid)).toBe(rootId)
  })

  it('yMoveEvent возвращает false для неизвестного события', () => {
    const { arr } = makeArray()
    expect(yMoveEvent(arr, 'nope', null)).toBe(false)
  })
})

/**
 * Перенос поддерева: порядок в Y.Array = порядок отображения, поэтому проверяем
 * не только `parent_id`, но и то, какое дерево соберёт `buildEventTree` — ровно
 * его видит человек в навигаторе.
 */
describe('yprovider — перенос поддерева (yMoveSubtree)', () => {
  /** Дерево как «уровень + заголовок»: удобно сравнивать целиком. */
  const tree = (arr: Y.Array<Y.Map<unknown>>) =>
    flattenTree(
      buildEventTree(
        arr.toArray().map((m) => ({
          id: (m.get('id') as string) ?? '',
          parentId: yEventParentId(m),
          title: (m.get('title') as string) ?? '',
        })),
        4,
      ),
    ).map((node) => `${'  '.repeat(node.depth)}${node.item.title}`)

  const titles = (arr: Y.Array<Y.Map<unknown>>) => arr.toArray().map((m) => m.get('title') as string)

  /**
   * Запись по id из текущего состояния массива. Перенос пересоздаёт Y.Map
   * (Yjs не перемещает вставленный тип), поэтому ссылка, взятая до переноса,
   * после него уже мертва — читать надо заново.
   */
  const mapById = (arr: Y.Array<Y.Map<unknown>>, id: unknown) =>
    arr.toArray().find((m) => m.get('id') === id)

  it('поднимает под-событие на верхний уровень', () => {
    const { arr } = makeArray()
    const chapter = yAddEvent(arr, 'Глава')
    const sub = yAddEvent(arr, 'Подсобытие', '', { parentId: chapter.get('id') as string })
    const subId = sub.get('id') as string
    yAddEvent(arr, 'Другая глава')

    expect(yMoveSubtree(arr, subId, null, 'inside')).toBe(true)
    expect(titles(arr)).toEqual(['Глава', 'Другая глава', 'Подсобытие'])
    expect(yEventParentId(mapById(arr, subId)!)).toBeNull()
    expect(tree(arr)).toEqual(['Глава', 'Другая глава', 'Подсобытие'])
  })

  it('переносит под-событие под другую главу — последним её ребёнком', () => {
    const { arr } = makeArray()
    const first = yAddEvent(arr, 'Г1')
    const moved = yAddEvent(arr, 'Подсобытие', '', { parentId: first.get('id') as string })
    const movedId = moved.get('id') as string
    const second = yAddEvent(arr, 'Г2')
    yAddEvent(arr, 'Своё подсобытие', '', { parentId: second.get('id') as string })

    expect(yMoveSubtree(arr, movedId, second.get('id') as string, 'inside')).toBe(true)
    expect(yEventParentId(mapById(arr, movedId)!)).toBe(second.get('id'))
    expect(tree(arr)).toEqual(['Г1', 'Г2', '  Своё подсобытие', '  Подсобытие'])
  })

  it('переносит главу вместе с потомками, не трогая их связи', () => {
    const { arr } = makeArray()
    const a = yAddEvent(arr, 'A')
    const aId = a.get('id') as string
    const a1 = yAddEvent(arr, 'A1', '', { parentId: aId })
    const a1Id = a1.get('id') as string
    const a2 = yAddEvent(arr, 'A2', '', { parentId: aId })
    const a2Id = a2.get('id') as string
    const b = yAddEvent(arr, 'B')

    expect(yMoveSubtree(arr, aId, b.get('id') as string, 'after')).toBe(true)
    expect(titles(arr)).toEqual(['A1', 'A2', 'B', 'A'])
    // Потомки остались на своих местах и всё ещё смотрят на A.
    expect(yEventParentId(mapById(arr, a1Id)!)).toBe(aId)
    expect(yEventParentId(mapById(arr, a2Id)!)).toBe(aId)
    expect(tree(arr)).toEqual(['B', 'A', '  A1', '  A2'])
  })

  it('ставит событие перед целью', () => {
    const { arr } = makeArray()
    const a = yAddEvent(arr, 'A')
    const b = yAddEvent(arr, 'B')
    expect(yMoveSubtree(arr, b.get('id') as string, a.get('id') as string, 'before')).toBe(true)
    expect(titles(arr)).toEqual(['B', 'A'])
  })

  it('применяет перенос одной транзакцией (одно обновление документа)', () => {
    const { doc, arr } = makeArray()
    const a = yAddEvent(arr, 'A')
    const b = yAddEvent(arr, 'B')
    let updates = 0
    const onUpdate = () => { updates++ }
    doc.on('update', onUpdate)

    expect(yMoveSubtree(arr, b.get('id') as string, a.get('id') as string, 'before')).toBe(true)
    doc.off('update', onUpdate)
    expect(updates).toBe(1)
  })

  it('запрещает цикл, себя и неизвестные id, не меняя дерево', () => {
    const { arr } = makeArray()
    const a = yAddEvent(arr, 'A')
    const aId = a.get('id') as string
    const a1 = yAddEvent(arr, 'A1', '', { parentId: aId })
    const a1Id = a1.get('id') as string
    const before = titles(arr)

    expect(yMoveSubtree(arr, aId, a1Id, 'inside')).toBe(false)
    expect(yMoveSubtree(arr, aId, aId, 'after')).toBe(false)
    expect(yMoveSubtree(arr, 'нет-такого', null, 'inside')).toBe(false)
    expect(yMoveSubtree(arr, aId, 'нет-такой', 'after')).toBe(false)
    expect(titles(arr)).toEqual(before)
    expect(yEventParentId(mapById(arr, a1Id)!)).toBe(aId)
  })

  it('запрещает слишком глубокий перенос', () => {
    const { arr } = makeArray()
    const root = yAddEvent(arr, 'root')
    const rootId = root.get('id') as string
    const l1 = yAddEvent(arr, 'l1', '', { parentId: rootId })
    const l1Id = l1.get('id') as string
    const l2 = yAddEvent(arr, 'l2', '', { parentId: l1Id })
    const l2Id = l2.get('id') as string
    const l3 = yAddEvent(arr, 'l3', '', { parentId: l2Id })
    const l3Id = l3.get('id') as string
    const other = yAddEvent(arr, 'other')
    const otherChild = yAddEvent(arr, 'other-child', '', { parentId: other.get('id') as string })

    // root вместе с цепочкой до l3 — 4 уровня; внутрь other-child (depth 1)
    // поддерево не влезает: самый глубокий потомок встал бы на 5-й уровень.
    expect(yMoveSubtree(arr, rootId, otherChild.get('id') as string, 'inside')).toBe(false)
    expect(yEventParentId(mapById(arr, l3Id)!)).toBe(l2Id)
    expect(yEventParentId(mapById(arr, rootId)!)).toBeNull()
    expect(tree(arr)).toEqual(['root', '  l1', '    l2', '      l3', 'other', '  other-child'])
  })
})
