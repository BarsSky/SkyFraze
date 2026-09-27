import { describe, expect, it } from 'vitest'
import { buildEventTree, descendantsOf, flattenTree, type EventLike } from './eventTree'

const ev = (id: string, parentId: string | null = null): EventLike => ({ id, parentId })

describe('buildEventTree — нормализация иерархии событий', () => {
  it('плоский список даёт только корней', () => {
    const roots = buildEventTree([ev('a'), ev('b'), ev('c')])
    expect(roots.map((n) => n.item.id)).toEqual(['a', 'b', 'c'])
    expect(roots.every((n) => n.depth === 0 && n.children.length === 0)).toBe(true)
  })

  it('вкладывает ребёнка в родителя и считает depth', () => {
    const roots = buildEventTree([ev('a'), ev('b', 'a'), ev('c', 'b')])
    expect(roots).toHaveLength(1)
    expect(roots[0].item.id).toBe('a')
    expect(roots[0].children[0].item.id).toBe('b')
    expect(roots[0].children[0].depth).toBe(1)
    expect(roots[0].children[0].children[0].depth).toBe(2)
  })

  it('сирота (родителя нет в списке) становится корнем, а не исчезает', () => {
    const roots = buildEventTree([ev('a'), ev('orphan', 'missing-id')])
    expect(roots.map((n) => n.item.id)).toEqual(['a', 'orphan'])
    expect(roots[1].depth).toBe(0)
  })

  it('самоссылка становится корнем', () => {
    const roots = buildEventTree([ev('self', 'self')])
    expect(roots.map((n) => n.item.id)).toEqual(['self'])
  })

  it('цикл разрывается: оба узла видны как корни', () => {
    const roots = buildEventTree([ev('a', 'b'), ev('b', 'a')])
    expect(roots.map((n) => n.item.id)).toEqual(['a', 'b'])
    expect(roots.every((n) => n.depth === 0)).toBe(true)
  })

  it('цикл из трёх узлов не теряет данные', () => {
    const roots = buildEventTree([ev('a', 'c'), ev('b', 'a'), ev('c', 'b')])
    const flat = flattenTree(roots)
    expect(flat.map((n) => n.item.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('глубина больше maxDepth поднимает узел в корень (данные не теряются)', () => {
    const roots = buildEventTree([ev('a'), ev('b', 'a'), ev('c', 'b')], 1)
    const flat = flattenTree(roots)
    expect(flat.map((n) => n.item.id).sort()).toEqual(['a', 'b', 'c'])
    const c = flat.find((n) => n.item.id === 'c')
    expect(c?.depth).toBe(0)
  })

  it('сохраняет порядок соседей из массива', () => {
    const roots = buildEventTree([ev('p'), ev('z', 'p'), ev('m', 'p'), ev('a', 'p')])
    expect(roots[0].children.map((n) => n.item.id)).toEqual(['z', 'm', 'a'])
  })

  it('дубликаты id игнорируются (остаётся первое вхождение)', () => {
    const roots = buildEventTree([ev('a'), ev('a')])
    expect(roots).toHaveLength(1)
  })

  it('пустые id отбрасываются', () => {
    const roots = buildEventTree([ev(''), ev('a')])
    expect(roots.map((n) => n.item.id)).toEqual(['a'])
  })

  it('не мутирует входные объекты', () => {
    const input = [ev('a'), ev('b', 'a')]
    const snapshot = JSON.stringify(input)
    buildEventTree(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('flattenTree обходит дерево в порядке отображения (pre-order)', () => {
    const roots = buildEventTree([ev('a'), ev('b', 'a'), ev('c'), ev('d', 'b')])
    expect(flattenTree(roots).map((n) => n.item.id)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('descendantsOf возвращает всех потомков без самого узла', () => {
    const roots = buildEventTree([ev('a'), ev('b', 'a'), ev('c', 'b')])
    expect(descendantsOf(roots[0]).map((n) => n.item.id)).toEqual(['b', 'c'])
  })
})
