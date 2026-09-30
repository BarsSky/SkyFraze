import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  MAX_DEFERRED_BYTES,
  clearDeferredState,
  deferredStateKey,
  readDeferredState,
  saveDeferredState,
  type StorageLike,
} from './deferredState'
import { yAddEvent } from './yprovider'

/**
 * Запас «несохранённое на закрытии вкладки». `localStorage` подменяем моком:
 * проверяем формат, пределы и то, что запас переживает круговой обход через
 * `Y.applyUpdate` (слияние, а не перезапись).
 */
function memoryStorage(): StorageLike & { dump: () => Record<string, string> } {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    dump: () => Object.fromEntries(data),
  }
}

/** Сломанный storage: приватный режим Safari кидает на любой записи. */
const brokenStorage: StorageLike = {
  getItem: () => null,
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => { throw new Error('QuotaExceededError') },
}

function docWithEvent(title: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc()
  yAddEvent(doc.getArray<Y.Map<unknown>>('events'), title)
  return { doc, update: Y.encodeStateAsUpdate(doc) }
}

describe('ключ запаса', () => {
  it('привязан к проекту: запас одного не применится к другому', () => {
    expect(deferredStateKey('p1')).not.toBe(deferredStateKey('p2'))
    expect(deferredStateKey('p1')).toContain('p1')
  })
})

describe('saveDeferredState / readDeferredState', () => {
  it('складывает апдейт и базовую ревизию и возвращает их обратно', () => {
    const storage = memoryStorage()
    const { update } = docWithEvent('Правка перед закрытием')

    expect(saveDeferredState('p1', update, 828, storage)).toBe(true)
    const back = readDeferredState('p1', storage)
    expect(back).not.toBeNull()
    expect(back!.baseRevision).toBe(828)
    expect(Array.from(back!.update)).toEqual(Array.from(update))
  })

  it('пустой апдейт не сохраняем: сохранять нечего', () => {
    const storage = memoryStorage()
    expect(saveDeferredState('p1', new Uint8Array(0), 1, storage)).toBe(false)
    expect(storage.dump()).toEqual({})
  })

  it('слишком большой запас не пишем: квота localStorage ~5 МБ на весь origin', () => {
    const storage = memoryStorage()
    const huge = new Uint8Array(MAX_DEFERRED_BYTES + 1)
    expect(saveDeferredState('p1', huge, 1, storage)).toBe(false)
    expect(readDeferredState('p1', storage)).toBeNull()
  })

  it('ровно на границе — ещё пишем', () => {
    const storage = memoryStorage()
    const limit = new Uint8Array(MAX_DEFERRED_BYTES)
    expect(saveDeferredState('p1', limit, 1, storage)).toBe(true)
  })

  it('падение storage (приватный режим, квота) — не исключение наружу', () => {
    const { update } = docWithEvent('Глава')
    expect(saveDeferredState('p1', update, 1, brokenStorage)).toBe(false)
    expect(readDeferredState('p1', brokenStorage)).toBeNull()
    expect(() => clearDeferredState('p1', brokenStorage)).not.toThrow()
  })

  it('отсутствие storage не ломает уход со страницы', () => {
    const { update } = docWithEvent('Глава')
    expect(saveDeferredState('p1', update, 1, null)).toBe(false)
    expect(readDeferredState('p1', null)).toBeNull()
    expect(() => clearDeferredState('p1', null)).not.toThrow()
  })

  it('мусор и чужая версия схемы читаются как «запаса нет»', () => {
    const storage = memoryStorage()
    for (const raw of ['не json', '{}', '{"v":2,"base64":"AA==","revision":1}', '{"v":1}', '{"v":1,"base64":""}']) {
      storage.setItem(deferredStateKey('p1'), raw)
      expect(readDeferredState('p1', storage)).toBeNull()
    }
  })

  it('отрицательная/нечисловая ревизия приводится к 0', () => {
    const storage = memoryStorage()
    const { update } = docWithEvent('Глава')
    saveDeferredState('p1', update, -5, storage)
    expect(readDeferredState('p1', storage)!.baseRevision).toBe(0)
    saveDeferredState('p1', update, Number.NaN, storage)
    expect(readDeferredState('p1', storage)!.baseRevision).toBe(0)
  })

  it('clearDeferredState убирает запас только у своего проекта', () => {
    const storage = memoryStorage()
    const { update } = docWithEvent('Глава')
    saveDeferredState('p1', update, 1, storage)
    saveDeferredState('p2', update, 1, storage)

    clearDeferredState('p1', storage)

    expect(readDeferredState('p1', storage)).toBeNull()
    expect(readDeferredState('p2', storage)).not.toBeNull()
  })
})

describe('применение запаса к документу (та же операция, что в yprovider)', () => {
  it('Y.applyUpdate сливает отложенную правку с серверным снапшотом', () => {
    // Серверный снапшот: глава «А».
    const server = new Y.Doc()
    yAddEvent(server.getArray<Y.Map<unknown>>('events'), 'А')
    const serverState = Y.encodeStateAsUpdate(server)

    // Локальная вкладка: та же глава плюс правка, которую не успели сохранить.
    const local = new Y.Doc()
    Y.applyUpdate(local, serverState)
    const events = local.getArray<Y.Map<unknown>>('events')
    yAddEvent(events, 'Б — не успела сохраниться')
    const storage = memoryStorage()
    saveDeferredState('p1', Y.encodeStateAsUpdate(local), 0, storage)

    // Следующее открытие проекта: снапшот с сервера, затем запас.
    const reopened = new Y.Doc()
    Y.applyUpdate(reopened, serverState, 'remote')
    const pending = readDeferredState('p1', storage)
    Y.applyUpdate(reopened, pending!.update, 'remote')

    const titles = reopened
      .getArray<Y.Map<unknown>>('events')
      .toArray()
      .map((m) => m.get('title'))
    // Правка не потерялась и не заменила серверное состояние.
    expect(titles).toContain('Б — не успела сохраниться')
    expect(titles).toContain('А')
  })

  it('повторное применение того же запаса не создаёт дубликатов', () => {
    const { doc, update } = docWithEvent('Глава')
    const once = new Y.Doc()
    Y.applyUpdate(once, update)
    Y.applyUpdate(once, update)
    Y.applyUpdate(once, update)
    expect(once.getArray<Y.Map<unknown>>('events').length).toBe(1)
    expect(doc.getArray<Y.Map<unknown>>('events').length).toBe(1)
  })
})
