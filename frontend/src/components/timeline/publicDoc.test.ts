import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { base64ToBytes, buildPublicDoc, bytesToBase64 } from './publicDoc'

describe('buildPublicDoc', () => {
  it('строит события из плоского дерева, когда снапшота нет', () => {
    const { events } = buildPublicDoc({
      state: undefined,
      events: [
        { id: 'a', parent_id: null, position: 0, title: 'Глава', body: 'текст' },
        { id: 'b', parent_id: 'a', position: 1, title: 'Под-событие', body: '' },
      ],
    })
    expect(events.length).toBe(2)
    expect(events.get(0).get('title')).toBe('Глава')
    // Вложенность должна доехать до стадии: именно по parent_id строится кадр-ветка
    expect(events.get(1).get('parent_id')).toBe('a')
    // У корня поля parent_id быть не должно — иначе он станет сиротой
    expect(events.get(0).get('parent_id')).toBeUndefined()
  })

  it('разворачивает CRDT-снапшот и предпочитает его таблице events', () => {
    const src = new Y.Doc()
    const arr = src.getArray<Y.Map<unknown>>('events')
    const m = new Y.Map<unknown>()
    m.set('id', 'x1')
    m.set('title', 'Из снапшота')
    m.set('bg_kind', 'tone')
    arr.push([m])
    const state = bytesToBase64(Y.encodeStateAsUpdate(src))

    const { events } = buildPublicDoc({
      state,
      // Заведомо «неправильные» строки: при наличии снапшота они игнорируются.
      events: [{ id: 'ignored', parent_id: null, position: 0, title: 'Игнор', body: '' }],
    })

    expect(events.length).toBe(1)
    expect(events.get(0).get('id')).toBe('x1')
    expect(events.get(0).get('title')).toBe('Из снапшота')
    expect(events.get(0).get('bg_kind')).toBe('tone')
  })

  it('пустая история не падает', () => {
    const { events } = buildPublicDoc({ state: undefined, events: [] })
    expect(events.length).toBe(0)
  })

  it('base64 переживает круговой обход байтов', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([0, 1, 2, 250, 255])
  })
})
