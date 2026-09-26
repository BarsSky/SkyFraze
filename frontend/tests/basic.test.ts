import { describe, expect, it } from 'vitest'
import { yAddEvent, useCollab } from '../src/collab/yprovider'
import * as Y from 'yjs'

describe('Yjs basics', () => {
  it('adds an event to a YArray', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('events')
    yAddEvent(arr, 'Act I', 'Hero awakens.')
    yAddEvent(arr, 'Act II', 'Hero learns truth.')
    expect(arr.length).toBe(2)
    expect(arr.get(0).get('title')).toBe('Act I')
    expect(arr.get(1).get('body')).toBe('Hero learns truth.')
  })

  it('serializes and restores state via binary update', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('events')
    yAddEvent(arr, 'Origin', 'Chapter one.')
    const update = Y.encodeStateAsUpdate(doc)
    expect(update.byteLength).toBeGreaterThan(0)

    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, update)
    const arr2 = doc2.getArray<Y.Map<unknown>>('events')
    expect(arr2.length).toBe(1)
    expect(arr2.get(0).get('title')).toBe('Origin')
  })
})

// avoid unused-import false positives
void useCollab
