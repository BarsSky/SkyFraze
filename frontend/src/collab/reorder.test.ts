import { describe, expect, it } from 'vitest'
import { buildEventTree, flattenTree, type EventLike } from './eventTree'
import { checkMove, moveEvent } from './reorder'

/**
 * Чистая логика переноса событий: без Yjs и без DOM.
 *
 * Проверяем два обещания модуля: (1) ход либо разрешён и даёт ровно ожидаемое
 * дерево после `buildEventTree`, либо запрещён (`null`); (2) входной массив не
 * мутируется.
 */

type Item = EventLike

/** [id, parentId] → плоский список в порядке отображения. */
function list(...rows: Array<[string, string | null]>): Item[] {
  return rows.map(([id, parentId]) => ({ id, parentId }))
}

/** Дерево в виде «префикс по уровню + id»: удобно сравнивать целиком. */
function shape(items: Item[], maxDepth = 4): string[] {
  return flattenTree(buildEventTree(items, maxDepth)).map(
    (node) => `${'  '.repeat(node.depth)}${node.item.id}`,
  )
}

/** Родители в порядке отображения — вторая половина ответа «где оказалось». */
function parents(items: Item[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const item of items) out[item.id] = item.parentId
  return out
}

describe('reorder.moveEvent — разрешённые переносы', () => {
  it('ставит событие перед соседом', () => {
    const items = list(['A', null], ['B', null], ['C', null])
    const next = moveEvent(items, 'C', 'A', 'before')

    expect(next).not.toBeNull()
    expect(shape(next!)).toEqual(['C', 'A', 'B'])
    expect(parents(next!).C).toBeNull()
  })

  it('ставит событие после соседа', () => {
    const items = list(['A', null], ['B', null], ['C', null])
    const next = moveEvent(items, 'A', 'C', 'after')

    expect(shape(next!)).toEqual(['B', 'C', 'A'])
  })

  it('переносит между главами: из одной главы в другую', () => {
    const items = list(['Г1', null], ['г1.1', 'Г1'], ['Г2', null], ['г2.1', 'Г2'])
    const next = moveEvent(items, 'г1.1', 'Г2', 'inside')

    expect(shape(next!)).toEqual(['Г1', 'Г2', '  г2.1', '  г1.1'])
    expect(parents(next!)['г1.1']).toBe('Г2')
  })

  it('«inside» кладёт в конец детей главы, а не в начало', () => {
    const items = list(['Г', null], ['a', 'Г'], ['b', 'Г'], ['X', null])
    const next = moveEvent(items, 'X', 'Г', 'inside')

    expect(shape(next!)).toEqual(['Г', '  a', '  b', '  X'])
  })

  it('targetId === null переносит в конец верхнего уровня', () => {
    const items = list(['Г', null], ['a', 'Г'], ['Д', null])
    const next = moveEvent(items, 'a', null, 'inside')

    expect(shape(next!)).toEqual(['Г', 'Д', 'a'])
    expect(parents(next!).a).toBeNull()
  })

  it('переносит под-событие на уровень выше (после бывшего родителя)', () => {
    const items = list(['Г', null], ['a', 'Г'], ['b', 'a'])
    const next = moveEvent(items, 'a', null, 'inside')

    expect(shape(next!)).toEqual(['Г', 'a', '  b'])
    expect(parents(next!).a).toBeNull()
    expect(parents(next!).b).toBe('a') // потомок поехал вместе с родителем
  })

  it('переносит поддерево целиком и сохраняет порядок внутри него', () => {
    const items = list(
      ['A', null],
      ['A1', 'A'],
      ['A2', 'A'],
      ['A2a', 'A2'],
      ['A1a', 'A1'],
      ['B', null],
    )
    const next = moveEvent(items, 'A', 'B', 'after')

    expect(shape(next!)).toEqual(['B', 'A', '  A1', '    A1a', '  A2', '    A2a'])
    // Соседи внутри поддерева остались в исходном порядке.
    const order = flattenTree(buildEventTree(next!, 4)).map((node) => node.item.id)
    expect(order.indexOf('A1')).toBeLessThan(order.indexOf('A2'))
    expect(order.indexOf('A1a')).toBeLessThan(order.indexOf('A2a'))
  })

  it('возвращает новый массив и не мутирует входные объекты', () => {
    const items = list(['A', null], ['B', null])
    const snapshot = JSON.parse(JSON.stringify(items))
    const next = moveEvent(items, 'B', 'A', 'before')

    expect(next).not.toBe(items)
    expect(items).toEqual(snapshot)
  })

  it('ровно на границе maxDepth перенос ещё разрешён', () => {
    const items = list(
      ['A', null],
      ['A1', 'A'],
      ['A1a', 'A1'],
      ['B', null],
      ['B1', 'B'],
    )
    // Поддерево A занимает 3 уровня, внутрь B1 (depth 1) → самый глубокий
    // потомок встаёт ровно на 4-й уровень: это ещё разрешено.
    const next = moveEvent(items, 'A', 'B1', 'inside')

    expect(next).not.toBeNull()
    expect(shape(next!)).toEqual(['B', '  B1', '    A', '      A1', '        A1a'])
  })
})

describe('reorder.moveEvent — запрещённые переносы', () => {
  it('запрещает перенос в себя', () => {
    const items = list(['A', null], ['B', null])
    expect(moveEvent(items, 'A', 'A', 'inside')).toBeNull()
    expect(moveEvent(items, 'A', 'A', 'before')).toBeNull()
  })

  it('запрещает перенос в собственного потомка (цикл)', () => {
    const items = list(['A', null], ['A1', 'A'], ['A1a', 'A1'])
    expect(moveEvent(items, 'A', 'A1', 'inside')).toBeNull()
    expect(moveEvent(items, 'A', 'A1a', 'after')).toBeNull()
    expect(checkMove(items, 'A', 'A1', 'inside')).toEqual({ ok: false, reason: 'cycle' })
  })

  it('запрещает выход за глубину с учётом высоты поддерева', () => {
    // Цепочка A → A1 → A1a → A1a1 занимает 4 уровня; внутрь B1 её не пустить.
    const items = list(
      ['A', null],
      ['A1', 'A'],
      ['A1a', 'A1'],
      ['A1a1', 'A1a'],
      ['B', null],
      ['B1', 'B'],
    )
    expect(moveEvent(items, 'A', 'B1', 'inside')).toBeNull()
    expect(checkMove(items, 'A', 'B1', 'inside')).toEqual({ ok: false, reason: 'depth' })
  })

  it('запрещает неизвестный источник и неизвестную цель', () => {
    const items = list(['A', null], ['B', null])
    expect(moveEvent(items, 'нет-такого', 'A', 'before')).toBeNull()
    expect(checkMove(items, 'нет-такого', null, 'inside')).toEqual({
      ok: false,
      reason: 'unknown-source',
    })
    expect(moveEvent(items, 'A', 'нет-такой', 'after')).toBeNull()
    expect(checkMove(items, 'A', 'нет-такой', 'after')).toEqual({
      ok: false,
      reason: 'unknown-target',
    })
  })

  it('одиночное событие без потомков можно опустить до 4 уровня', () => {
    const items = list(['A', null], ['B', null], ['B1', 'B'], ['B1a', 'B1'], ['B1a1', 'B1a'])
    // B1a1 уже на 3 уровне: внутрь него (4 уровень) одиночное A влезает.
    expect(moveEvent(items, 'A', 'B1a1', 'inside')).not.toBeNull()
  })
})
