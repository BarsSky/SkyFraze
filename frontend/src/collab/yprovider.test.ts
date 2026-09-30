import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { buildEventTree, flattenTree } from './eventTree'
import {
  applyPendingState,
  commitSnapshot,
  shouldClearPending,
  yAddEvent,
  yDeleteEvent,
  yEnsureEventIds,
  yEventId,
  yEventParentId,
  yFlatTree,
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

/**
 * Отложенное состояние (Фаза 0.4): запас с прошлого закрытия вкладки нужно слить
 * с серверным снапшотом, а убрать его — только когда он точно внутри
 * сохранённого состояния.
 */
describe('yprovider — отложенное состояние', () => {
  const titles = (doc: Y.Doc) =>
    (doc.getArray<Y.Map<unknown>>('events').toArray() as Y.Map<unknown>[]).map((m) => m.get('title'))

  it('сливает серверный снапшот и запас: не теряется ни то, ни другое', () => {
    const server = new Y.Doc()
    yAddEvent(server.getArray<Y.Map<unknown>>('events'), 'Серверная глава')
    const serverState = Y.encodeStateAsUpdate(server)

    const local = new Y.Doc()
    Y.applyUpdate(local, serverState)
    yAddEvent(local.getArray<Y.Map<unknown>>('events'), 'Правка перед закрытием')
    const pending = { update: Y.encodeStateAsUpdate(local), baseRevision: 828 }

    const reopened = new Y.Doc()
    expect(applyPendingState(reopened, serverState, pending)).toBe(true)
    expect(titles(reopened)).toEqual(['Серверная глава', 'Правка перед закрытием'])
  })

  it('без запаса просто применяет серверное состояние', () => {
    const server = new Y.Doc()
    yAddEvent(server.getArray<Y.Map<unknown>>('events'), 'Глава')
    const reopened = new Y.Doc()
    expect(applyPendingState(reopened, Y.encodeStateAsUpdate(server), null)).toBe(false)
    expect(titles(reopened)).toEqual(['Глава'])
  })

  it('сломанный запас не роняет открытие проекта', () => {
    const reopened = new Y.Doc()
    const broken = { update: new Uint8Array([255, 255, 255]), baseRevision: 0 }
    expect(() => applyPendingState(reopened, new Uint8Array(0), broken)).not.toThrow()
  })

  it('запас убираем только когда он действительно внутри сохранённого состояния', () => {
    const doc = new Y.Doc()
    yAddEvent(doc.getArray<Y.Map<unknown>>('events'), 'Глава')
    const pending = { update: Y.encodeStateAsUpdate(doc), baseRevision: 1 }

    // Содержимое запаса слито в doc — запись можно подтвердить, запас не нужен.
    expect(shouldClearPending(pending, Y.encodeStateAsUpdate(doc))).toBe(true)

    // Состояние без запаса (например, запись не удалась, и doc откатили) —
    // запас обязан остаться, иначе правка исчезнет.
    const other = new Y.Doc()
    yAddEvent(other.getArray<Y.Map<unknown>>('events'), 'Другое')
    expect(shouldClearPending(pending, Y.encodeStateAsUpdate(other))).toBe(false)
    expect(shouldClearPending(null, Y.encodeStateAsUpdate(doc))).toBe(false)
  })
})

/**
 * Запись снапшота с ревизией: единственный путь сохранения (debounce,
 * safety-net, повтор после отложенного состояния). Проверяем восстановление
 * после 409 и, главное, что неудача не выдаётся за успех — иначе запас
 * удалялся бы вместе с несохранённой правкой.
 */
describe('yprovider — запись снапшота (commitSnapshot)', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)

  it('успешная запись отдаёт новую ревизию с сервера', async () => {
    const put = vi.fn().mockResolvedValue({ ok: true, revision: 9 })
    const fetchRemote = vi.fn()

    const result = await commitSnapshot(bytes(1), 8, {
      put,
      fetchRemote,
      encodeState: () => bytes(2),
    })

    expect(result).toEqual({ ok: true, revision: 9 })
    expect(put).toHaveBeenCalledTimes(1)
    // База — та, что была на руках, а не выдуманная.
    expect(put.mock.calls[0][1]).toBe(8)
    expect(fetchRemote).not.toHaveBeenCalled()
  })

  it('без ревизии в ответе оставляет прежнюю базу', async () => {
    const result = await commitSnapshot(bytes(1), 8, {
      put: async () => ({ ok: true }),
      fetchRemote: async () => null,
      encodeState: () => bytes(2),
    })
    expect(result).toEqual({ ok: true, revision: 8 })
  })

  it('при 409 перечитывает состояние, мержит и повторяет один раз', async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, conflict: true, currentRevision: 12 })
      .mockResolvedValueOnce({ ok: true, revision: 13 })
    // mergeRemoteState уже слил серверное состояние в doc, поэтому encodeState
    // возвращает другое (объединённое) содержимое.
    const merged = bytes(1, 2)

    const result = await commitSnapshot(bytes(1), 8, {
      put,
      fetchRemote: async () => 12,
      encodeState: () => merged,
    })

    expect(result).toEqual({ ok: true, revision: 13 })
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[0][1]).toBe(8)
    // Повтор идёт на актуальной базе, а тело — уже слитое состояние.
    expect(put.mock.calls[1][1]).toBe(12)
    expect(Array.from(put.mock.calls[1][0])).toEqual([1, 2])
  })

  it('конфликт, который не удалось прочитать, отдаёт ok: false и ревизию с сервера', async () => {
    const put = vi.fn().mockResolvedValue({ ok: false, conflict: true, currentRevision: 12 })
    const result = await commitSnapshot(bytes(1), 8, {
      put,
      fetchRemote: async () => null,
      encodeState: () => bytes(1),
    })
    // Успехом это не считается: запас в localStorage должен остаться.
    expect(result).toEqual({ ok: false, revision: 12 })
  })

  it('ошибка сети отдаёт ok: false и не трогает базу', async () => {
    const result = await commitSnapshot(bytes(1), 8, {
      put: async () => ({ ok: false }),
      fetchRemote: async () => null,
      encodeState: () => bytes(1),
    })
    expect(result).toEqual({ ok: false, revision: 8 })
  })

  it('повтор после конфликта, который снова конфликтует, не выдаётся за успех', async () => {
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, conflict: true, currentRevision: 12 })
      .mockResolvedValueOnce({ ok: false, conflict: true, currentRevision: 14 })
    const result = await commitSnapshot(bytes(1), 8, {
      put,
      fetchRemote: async () => 12,
      encodeState: () => bytes(2),
    })
    // Повтор ровно один: третьего запроса нет, и правка не считается сохранённой.
    expect(put).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: false, revision: 12 })
  })
})

describe('yprovider — дата в проекции дерева', () => {
  it('дата уходит на сервер в RFC3339 (он ждёт time.Time)', () => {
    const { arr } = makeArray()
    const chapter = yAddEvent(arr, 'Глава', 'текст')
    chapter.set('event_date', '2789-04-12')
    const payload = yFlatTree(arr)
    expect(payload[0].event_date).toBe('2789-04-12T00:00:00Z')
  })

  it('без даты в CRDT поля нет вовсе: сервер не трогает дату, которую клиент не видел', () => {
    const { arr } = makeArray()
    yAddEvent(arr, 'Глава', 'текст')
    const payload = yFlatTree(arr)
    expect('event_date' in payload[0]).toBe(false)
  })

  it('очищенная дата уходит пустой: это осознанное «убрать дату из базы»', () => {
    const { arr } = makeArray()
    const chapter = yAddEvent(arr, 'Глава', 'текст')
    chapter.set('event_date', '2026-01-01')
    chapter.set('event_date', '')
    const payload = yFlatTree(arr)
    expect(payload[0].event_date).toBeNull()
  })
})
