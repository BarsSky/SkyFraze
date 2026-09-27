import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  yAddEvent,
  yDeleteEvent,
  yEnsureEventIds,
  yEventId,
  yEventParentId,
  yMoveEvent,
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
