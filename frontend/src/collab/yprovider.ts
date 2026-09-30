import * as Y from 'yjs'
import { useEffect, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { buildEventTree } from './eventTree'
import { moveEvent, type DropPlace } from './reorder'
import { randomId } from '../lib/uuid'
import { collabSocketUrl } from './socketUrl'
import { getEventState, listEventRows, putEventState, syncEventTree, type FlatEventNode } from '../api/events'

export type YArray = Y.Array<Y.Map<unknown>>
export type YMap = Y.Map<unknown>

export interface SyncTreeResult {
  ok: boolean
  reason?: 'forbidden' | 'rejected' | 'error'
  /** сколько узлов CRDT приведено к нормализованному дереву перед повтором */
  repaired?: number
}

export interface CollabHandle {
  doc: Y.Doc
  events: YArray
  wsUrl: (projectId: string) => string
  save: () => Promise<void>
  flushNow: () => Promise<void>
  /** Проецирует текущее дерево CRDT на сервер (серверная модель иерархии). */
  syncTree: () => Promise<SyncTreeResult>
  /**
   * Разрешение на запись. `null` — роль ещё не известна (страница не получила
   * проект): до этого момента запись не отправляем, иначе читатель (наблюдатель
   * или соавтор с доступом только на чтение) получал бы 403 в консоль.
   */
  setWritable: (allowed: boolean | null) => void
  /** Открылось ли realtime-соединение: без него правки сохраняются, но не летят другим. */
  connected: boolean
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = useAuthStore.getState().accessToken
  return {
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    ...(extra ?? {}),
  }
}

/**
 * Подключение к Yjs-серверу + REST snapshot.
 *
 * Снапшот версионируется: сервер принимает запись только от известной базовой
 * ревизии (X-Skyfraze-Base-Revision). При 409 клиент перечитывает состояние,
 * мержит его в свой doc (CRDT не теряет правки) и повторяет запись один раз.
 * Структура дерева дополнительно проецируется на сервер (`syncTree`), где
 * проверяются циклы/глубина/принадлежность проекту.
 */
export function useCollab(projectId: string): CollabHandle | null {
  const [handle, setHandle] = useState<CollabHandle | null>(null)
  // Отдельным состоянием, а не полем handle: открытие сокета не должно
  // пересобирать документ и переподключаться.
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const doc = new Y.Doc()
    const events = doc.getArray<Y.Map<unknown>>('events')
    if (typeof window !== 'undefined') {
      ;(window as any).__yjsDoc = doc
    }

    const tok = useAuthStore.getState().accessToken
    const wsUrl = collabSocketUrl(projectId)
    // WebSocket может быть недоступен по многим причинам: HTTPS-страница и ws://
    // (браузер бросает SecurityError), прокси без поддержки Upgrade, блокировка в
    // корпоративной сети. Ни один из этих случаев не должен ронять приложение:
    // содержимое проекта грузится по REST (см. loadContent), а realtime — бонус.
    let ws: WebSocket | null = null
    let wsOpened = false
    try {
      ws = new WebSocket(wsUrl + '?token=' + encodeURIComponent(tok ?? ''))
      ws.binaryType = 'arraybuffer'
    } catch (e) {
      console.warn('[yprovider] realtime недоступен, работаем без него:', String(e))
    }
    let active = true
    let revision = 0
    /**
     * Роль ещё не известна, пока страница не получила проект: за это время уже
     * успевают уйти первая проекция дерева и запись снапшота, и читатель получал
     * 403. Поэтому до выяснения роли запись не отправляем вовсе.
     */
    let writable: boolean | null = null
    let treeSynced = false

    const canWrite = () => writable === true

    const syncTree = async (): Promise<SyncTreeResult> => {
      if (!canWrite()) return { ok: false, reason: 'forbidden' }
      const payload = yFlatTree(events)
      if (payload.length === 0) {
        treeSynced = true
        return { ok: true }
      }
      try {
        await syncEventTree(projectId, payload)
        treeSynced = true
        return { ok: true }
      } catch (e) {
        const status = (e as { response?: Response })?.response?.status
        if (status === 403) return { ok: false, reason: 'forbidden' }
        if (status === 400) {
          // Сервер отклонил структуру (цикл/сирота/глубина): приводим CRDT
          // к нормализованному виду и повторяем один раз.
          const repaired = yRepairHierarchy(events)
          if (repaired > 0) {
            try {
              await syncEventTree(projectId, yFlatTree(events))
              return { ok: true, repaired }
            } catch {
              /* ignore */
            }
          }
          return { ok: false, reason: 'rejected', repaired }
        }
        return { ok: false, reason: 'error' }
      }
    }

    /**
     * Загрузка содержимого идёт по REST — НЕЗАВИСИМО от WebSocket.
     *
     * Раньше снапшот запрашивался только в `ws.onopen`. Если соединение не
     * поднималось (проверка Origin, прокси, мобильная сеть), проект выглядел
     * пустым: ни кадров, ни редакторов — «пустая страница». Теперь контент
     * приезжает всегда, а WebSocket отвечает только за реальное время.
     */
    const loadContent = async (): Promise<void> => {
      try {
        const snap = await getEventState(projectId)
        if (!active) return
        revision = snap.revision
        if (snap.state.byteLength > 0) {
          Y.applyUpdate(doc, snap.state, 'remote')
        }
      } catch (e) {
        console.log('[yprovider] snapshot fetch error:', String(e))
      }

      // Снапшота нет, а дерево в базе есть — так выглядит проект, созданный через
      // API, или импортированный из архива, снятого с проекта без CRDT. Стадия
      // читает только CRDT, поэтому без засева такой проект показывался бы пустым.
      // Не путать с «пользователь всё удалил»: там пусто и в базе.
      if (events.length === 0 && active) {
        try {
          const rows = await listEventRows(projectId)
          if (rows.length > 0 && events.length === 0 && active) {
            doc.transact(() => {
              for (const row of rows) {
                const m = new Y.Map<unknown>()
                m.set('id', row.id)
                if (row.parent_id) m.set('parent_id', row.parent_id)
                m.set('title', row.title)
                m.set('body', row.body)
                events.push([m])
              }
            }, 'seed')
          }
        } catch (e) {
          console.log('[yprovider] seed from REST error:', String(e))
        }
      }
    }

    // Обработчики навешиваем только если сокет удалось создать.
    if (ws) {
      ws.onopen = async () => {
        wsOpened = true
        setConnected(true)
        // Соединение могли открыть раньше, чем приехал снапшот: отправляем то, что
        // уже есть, а остальное уйдёт через doc.on('update') после загрузки.
        const update = Y.encodeStateAsUpdate(doc)
        if (update.byteLength > 0 && ws) ws.send(update)
        // Первичная проекция дерева на сервер: у проекта может быть история в
        // CRDT и пустая реляционная модель (после миграции 0002). Роль к этому
        // моменту может быть ещё не известна — тогда проекцию сделает setWritable.
        if (active && canWrite() && !treeSynced) void syncTree()
      }
      ws.onclose = () => setConnected(false)
      ws.onerror = () => setConnected(false)
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          try {
            Y.applyUpdate(doc, new Uint8Array(ev.data), 'remote')
          } catch {
            /* ignore malformed */
          }
        }
      }
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPromise: Promise<void> = Promise.resolve()
    // Сериализация записей снапшота: две собственные параллельные записи
    // (debounce + safety-net) с одной базовой ревизией дают ложный 409.
    let saving = false
    let queued = false

    const doSave = async () => {
      const state = Y.encodeStateAsUpdate(doc)
      const first = await putEventState(projectId, state, revision)
      if (first.ok) {
        revision = first.revision ?? revision
        return
      }
      if (first.conflict) {
        // Кто-то записал снапшот раньше: перечитываем, мержим и повторяем.
        try {
          const snap = await getEventState(projectId)
          revision = first.currentRevision ?? snap.revision
          if (snap.state.byteLength > 0) {
            Y.applyUpdate(doc, snap.state, 'remote')
          }
          const retry = await putEventState(projectId, Y.encodeStateAsUpdate(doc), revision)
          if (retry.ok) revision = retry.revision ?? revision
        } catch {
          /* offline ok */
        }
      }
    }

    const flushNow = async (): Promise<void> => {
      if (!active || !canWrite()) return
      if (saving) {
        queued = true
        return
      }
      saving = true
      try {
        await doSave()
      } catch {
        /* offline ok */
      } finally {
        saving = false
      }
      if (queued) {
        queued = false
        await flushNow()
      }
    }
    const save = (): Promise<void> => {
      if (!canWrite()) return Promise.resolve()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        pendingPromise = flushNow()
        pendingPromise.finally(() => { pendingPromise = Promise.resolve() })
      }, 300)
      return pendingPromise
    }

    doc.on('update', (update, origin) => {
      if (origin === 'remote') return
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(update) } catch { /* ignore */ }
      }
      void save()
    })

    const safetyNet = setInterval(() => {
      if (!active) return
      void flushNow()
    }, 30000)

    // Последняя запись при уходе со страницы: sendBeacon не умеет заголовки,
    // поэтому используем fetch с keepalive — он несёт базовую ревизию.
    const onUnload = () => {
      if (!active || !wsOpened || !canWrite()) return
      const state = Y.encodeStateAsUpdate(doc)
      const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
      safe.set(state)
      try {
        void fetch(`/api/projects/${projectId}/events/state`, {
          method: 'PUT',
          headers: authHeaders({
            'Content-Type': 'application/octet-stream',
            'X-Skyfraze-Base-Revision': String(revision),
          }),
          body: new Blob([safe]),
          keepalive: true,
        }).catch(() => {/* ignore */})
      } catch { /* ignore */ }
    }
    window.addEventListener('pagehide', onUnload)

    /**
     * Страница сообщает роль, когда получила проект. Если запись разрешена и
     * первичная проекция дерева ещё не уходила (её пропустили, пока роль была
     * неизвестна), делаем её здесь — один раз.
     */
    const setWritable = (allowed: boolean | null) => {
      const previous = writable
      writable = allowed
      if (allowed === true && previous !== true && active && wsOpened && !treeSynced) {
        void syncTree()
      }
    }

    setHandle({ doc, events, wsUrl: () => wsUrl, save, flushNow, syncTree, setWritable, connected: false })
    // Контент тянем сразу, не дожидаясь WebSocket (см. loadContent).
    void loadContent()

    return () => {
      active = false
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(safetyNet)
      window.removeEventListener('pagehide', onUnload)
      // flush делаем ТОЛЬКО если WS-соединение успешно открылось (значит, мы доверенный клиент)
      if (wsOpened && canWrite()) void flushNow()
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [projectId])

  // connected живёт отдельно от handle: собираем актуальный объект при отдаче.
  return handle ? { ...handle, connected } : null
}

/**
 * Добавляет событие в YArray.
 * `parentId` делает его под-событием; без него — главой верхнего уровня.
 */
export interface NewEventOptions {
  /** id родителя; null/undefined — событие верхнего уровня */
  parentId?: string | null
  /** позиция в Y.Array (по умолчанию — в конец) */
  position?: number
}

export function yAddEvent(
  events: YArray,
  title = 'Новое событие',
  body = '',
  opts: NewEventOptions = {},
): YMap {
  const m = new Y.Map<unknown>()
  m.set('id', randomId())
  m.set('title', title)
  m.set('body', body)
  m.set('created_at', new Date().toISOString())
  if (opts.parentId) m.set('parent_id', opts.parentId)
  if (typeof opts.position === 'number') {
    const at = Math.max(0, Math.min(events.length, opts.position))
    events.insert(at, [m])
  } else {
    events.push([m])
  }
  return m
}

/** Стабильный id события: если его нет — записываем один раз в сам CRDT. */
export function yEventId(m: YMap): string {
  const cur = m.get('id')
  if (typeof cur === 'string' && cur.length > 0) return cur
  const id = randomId()
  m.set('id', id)
  return id
}

/** parent_id с нормализацией: пустая строка/не-строка трактуются как «корень». */
export function yEventParentId(m: YMap): string | null {
  const p = m.get('parent_id')
  return typeof p === 'string' && p.length > 0 ? p : null
}

/** Восстанавливает отсутствующие id у всех событий (один раз при подключении). */
export function yEnsureEventIds(events: YArray): number {
  let fixed = 0
  for (const m of events.toArray() as YMap[]) {
    const cur = m.get('id')
    if (typeof cur !== 'string' || cur.length === 0) {
      m.set('id', randomId())
      fixed++
    }
  }
  return fixed
}

/**
 * Удаляет событие вместе со всеми потомками. Возвращает число удалённых записей.
 * Удаляем с конца, чтобы индексы не съезжали.
 */
export function yDeleteEvent(events: YArray, id: string): number {
  const doomed = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const m of events.toArray() as YMap[]) {
      const eid = m.get('id')
      if (typeof eid !== 'string' || doomed.has(eid)) continue
      const pid = yEventParentId(m)
      if (pid && doomed.has(pid)) {
        doomed.add(eid)
        grew = true
      }
    }
  }
  let removed = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const eid = (events.get(i).get('id') as string | undefined) ?? ''
    if (doomed.has(eid)) {
      events.delete(i, 1)
      removed++
    }
  }
  return removed
}

/**
 * Переносит событие под другого родителя (null — в корень).
 * Возвращает false, если перенос запрещён: на себя или в собственного потомка,
 * либо если событие не найдено.
 */
export function yMoveEvent(events: YArray, id: string, newParentId: string | null): boolean {
  if (newParentId === id) return false
  const byId = new Map<string, YMap>()
  for (const m of events.toArray() as YMap[]) {
    const eid = m.get('id')
    if (typeof eid === 'string' && eid.length > 0) byId.set(eid, m)
  }
  const target = byId.get(id)
  if (!target) return false

  const guard = new Set<string>()
  let cursor = newParentId
  while (cursor) {
    if (cursor === id) return false // перенос в собственного потомка
    if (guard.has(cursor)) return false // исходные данные уже содержат цикл
    guard.add(cursor)
    const parent = byId.get(cursor)
    cursor = parent ? yEventParentId(parent) : null
  }

  if (newParentId) target.set('parent_id', newParentId)
  else target.delete('parent_id')
  return true
}

/**
 * Переносит событие вместе с его поддеревом в новую позицию дерева.
 *
 * Порядок в Y.Array = порядок отображения, поэтому перенос — это сдвиг одной
 * записи в массиве плюс `parent_id` у её корня: потомки остаются на своих
 * местах и «приезжают» под нового родителя сами, ничего разбирать не нужно.
 * Проверку (цикл, глубина) и целевую позицию считает чистая `moveEvent`, здесь
 * она только применяется к Y.Array — одной транзакцией, чтобы соавторы увидели
 * перенос целиком, а не промежуточное состояние.
 *
 * Запись пересоздаётся копией: Yjs не умеет перемещать уже вставленный тип
 * (`insert` того же Y.Map падает — тип интегрируется в документ ровно один раз).
 * Копия несёт тот же `id` и все поля, поэтому потомки и ссылки не рвутся,
 * `buildEventTree` схлопывает возможный дубликат id и дерево остаётся целым.
 * Цена: правка того же события соавтором ровно в момент переноса может
 * потеряться — это ограничение самого Yjs, а не расчёта позиции.
 *
 * Возвращает false, если перенос запрещён (неизвестный id, цикл, глубина > 4).
 */
export function yMoveSubtree(
  events: YArray,
  id: string,
  targetId: string | null,
  place: DropPlace,
): boolean {
  // Один снимок массива: индексы из него же и применяем, иначе параллельная
  // правка соавтора сдвинула бы позиции между чтением и записью.
  const snapshot = events.toArray() as YMap[]
  const flat = snapshot.map((m) => ({
    id: (m.get('id') as string | undefined) ?? '',
    parentId: yEventParentId(m),
  }))
  const next = moveEvent(flat, id, targetId, place)
  if (!next) return false

  const from = flat.findIndex((e) => e.id === id)
  const to = next.findIndex((e) => e.id === id)
  if (from < 0 || to < 0) return false

  const moved = snapshot[from]
  const parentId = next[to].parentId

  const applyParent = (map: YMap) => {
    if (parentId) map.set('parent_id', parentId)
    else map.delete('parent_id')
  }

  const apply = () => {
    // Уровень поменялся, порядок — нет: тип трогать не нужно, правим поле.
    if (from === to) {
      applyParent(moved)
      return
    }
    // `to` посчитан для массива без переносимой записи — сначала удаляем,
    // потом вставляем копию по этому индексу.
    const copy = moved.clone()
    applyParent(copy)
    events.delete(from, 1)
    events.insert(to, [copy])
  }

  const doc = events.doc
  if (doc) doc.transact(apply, 'reorder')
  else apply()
  return true
}

/** Плоский payload дерева для проекции на сервер. */
export function yFlatTree(events: YArray): FlatEventNode[] {
  const out: FlatEventNode[] = []
  let position = 0
  for (const m of events.toArray() as YMap[]) {
    const id = (m.get('id') as string | undefined) ?? ''
    if (!id) continue
    out.push({
      id,
      parent_id: yEventParentId(m),
      position: position++,
      title: ((m.get('title') as string | undefined) ?? '').trim(),
      body: ((m.get('body') as string | undefined) ?? '').trim(),
    })
  }
  return out
}

/**
 * Приводит CRDT к нормализованному дереву: узлы с отсутствующим родителем,
 * участники циклов и слишком глубокие под-события поднимаются в корень.
 * Нужна, когда сервер отклонил проекцию (400) — после починки клиент и
 * сервер видят одинаковую структуру. Возвращает число исправленных связей.
 */
export function yRepairHierarchy(events: YArray): number {
  const flat = yFlatTree(events)
  if (flat.length === 0) return 0
  const roots = buildEventTree(
    flat.map((n) => ({ id: n.id, parentId: n.parent_id, title: n.title, body: n.body })),
    4,
  )
  const effectiveParent = new Map<string, string | null>()
  const walk = (node: { item: { id: string }; children: any[] }, parentId: string | null) => {
    effectiveParent.set(node.item.id, parentId)
    for (const child of node.children) walk(child, node.item.id)
  }
  for (const root of roots) walk(root, null)

  let fixed = 0
  for (const n of flat) {
    const want = effectiveParent.get(n.id) ?? null
    if (want !== n.parent_id && yMoveEvent(events, n.id, want)) fixed++
  }
  return fixed
}
