import * as Y from 'yjs'
import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/auth'
import { buildEventTree } from './eventTree'
import { moveEvent, type DropPlace } from './reorder'
import { randomId } from '../lib/uuid'
import { collabSocketUrl } from './socketUrl'
import { createReconnectLoop, type ReconnectLoop } from './backoff'
import { OFFLINE_AFTER_ATTEMPTS, type CollabStatus } from './connection'
import { connectTabChannel, createTabChannel } from './broadcast'
import {
  clearDeferredState,
  defaultStorage,
  readDeferredState,
  saveDeferredState,
  type PendingState,
} from './deferredState'
import {
  getEventState,
  httpStatusOf,
  listEventRows,
  putEventState,
  syncEventTree,
  type FlatEventNode,
  type PutStateResult,
} from '../api/events'

export type YArray = Y.Array<Y.Map<unknown>>
export type YMap = Y.Map<unknown>

export interface SyncTreeResult {
  ok: boolean
  reason?: 'forbidden' | 'rejected' | 'error' | 'conflict'
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
  /**
   * Состояние соединения целиком: «подключаюсь», «открыто», «переподключаюсь»
   * после обрыва, «связи нет». Нужно интерфейсу, чтобы отличить временный
   * разрыв от «realtime тут недоступен вовсе» — это разные сообщения человеку.
   */
  status: CollabStatus
  /** Сколько попыток переподключения подряд уже сделано (0 — соединение живо). */
  reconnectAttempt: number
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const tok = useAuthStore.getState().accessToken
  return {
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    ...(extra ?? {}),
  }
}

/**
 * Одна запись снапшота с восстановлением после 409.
 *
 * Вынесена отдельной функцией без доступа к состоянию эффекта (ревизия
 * возвращается наружу), поэтому её можно проверить тестом с моками API. Это
 * единственный путь сохранения — и debounce, и safety-net, и повтор при
 * открытии проекта после отложенного состояния идут через неё.
 *
 * `fetchRemote` перечитывает серверное состояние и сливает его в doc перед
 * повтором: CRDT-слияние сохраняет и чужие правки, и свои. `encodeState`
 * вызывается заново после merge — состояние документа уже другое.
 */
export async function commitSnapshot(
  state: Uint8Array,
  baseRevision: number,
  deps: {
    put: (state: Uint8Array, base: number) => Promise<PutStateResult>
    fetchRemote: () => Promise<number | null>
    encodeState: () => Uint8Array
  },
): Promise<{ ok: boolean; revision: number }> {
  const first = await deps.put(state, baseRevision)
  if (first.ok) return { ok: true, revision: first.revision ?? baseRevision }
  if (!first.conflict) return { ok: false, revision: baseRevision }

  // Кто-то записал снапшот раньше: перечитываем, мержим и повторяем один раз.
  const snapshot = await deps.fetchRemote()
  const nextBase = first.currentRevision ?? snapshot ?? baseRevision
  const retry = await deps.put(deps.encodeState(), nextBase)
  if (retry.ok) return { ok: true, revision: retry.revision ?? nextBase }
  return { ok: false, revision: nextBase }
}

/**
 * Проекция дерева с ревизионной защитой.
 *
 * Проекция — полная замена серверного дерева, поэтому устаревший клиент
 * (например, тот, что давно не получал апдейты) сносил чужие строки. Теперь
 * уходит базовая ревизия снапшота (`X-Skyfraze-Base-Revision`) — ровно та же
 * оптимистичная блокировка, что у `PUT /events/state`, и сервер её требует:
 * без заголовка он отвечает 428, при устаревшей базе — 409 и дерево не
 * трогает. Оба случая восстановимые: перечитываем состояние, сливаем его в doc
 * (CRDT не теряет правки) и повторяем проекцию один раз на актуальной базе.
 */
export function useCollab(projectId: string): CollabHandle | null {
  const [handle, setHandle] = useState<CollabHandle | null>(null)
  // Отдельным состоянием, а не полем handle: открытие сокета не должно
  // пересобирать документ и переподключаться.
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<CollabStatus>('connecting')
  const [reconnectAttempt, setReconnectAttempt] = useState(0)

  useEffect(() => {
    const doc = new Y.Doc()
    const events = doc.getArray<Y.Map<unknown>>('events')
    if (typeof window !== 'undefined') {
      ;(window as any).__yjsDoc = doc
    }

    const tok = useAuthStore.getState().accessToken
    const wsUrl = collabSocketUrl(projectId)
    let ws: WebSocket | null = null
    let active = true
    /** Хоть раз соединение открывалось: признак «мы доверенный клиент» для записи. */
    let wsOpened = false
    let revision = 0
    /**
     * Роль ещё не известна, пока страница не получила проект: за это время уже
     * успевают уйти первая проекция дерева и запись снапшота, и читатель получал
     * 403. Поэтому до выяснения роли запись не отправляем вовсе.
     */
    let writable: boolean | null = null
    let treeSynced = false
    /** Отложенный на уходе со страницы апдейт — если он был, его надо слить и сохранить. */
    let deferred: PendingState | null = null

    const canWrite = () => writable === true
    const setStatusOf = (next: CollabStatus, attempt: number) => {
      setStatus(next)
      setConnected(next === 'open')
      // Отдельное число, а не строка: интерфейс показывает «переподключаюсь…»
      // и переключается на «связи нет» по числу неудачных попыток подряд.
      setReconnectAttempt(next === 'open' ? 0 : attempt)
    }
    /**
     * Одна попытка соединения.
     *
     * Живёт в цикле переподключения (`backoff.ts`), а не в одном `new WebSocket`
     * на весь срок жизни страницы: после обрыва (сон ноутбука, смена сети,
     * перезапуск бэкенда) клиент раньше оставался без realtime до перезагрузки —
     * чужие правки не приезжали, свои уходили только в БД.
     */
    const openSocket = () => {
      if (!active) return
      // WebSocket может быть недоступен по многим причинам: HTTPS-страница и ws://
      // (браузер бросает SecurityError), прокси без поддержки Upgrade, блокировка в
      // корпоративной сети. Ни один из этих случаев не должен ронять приложение:
      // содержимое проекта грузится по REST (см. loadContent), а realtime — бонус.
      let socket: WebSocket
      try {
        socket = new WebSocket(wsUrl + '?token=' + encodeURIComponent(tok ?? ''))
        socket.binaryType = 'arraybuffer'
      } catch {
        // Неудача создания — такая же неудача, как обрыв: планируем следующую
        // попытку. Ошибку не пишем в консоль на каждой итерации: при долгом
        // обрыве это спам, от которого вкладка тормозит сильнее самого обрыва.
        loop.schedule()
        return
      }
      ws = socket

      socket.onopen = async () => {
        if (!active) return
        wsOpened = true
        loop.reset()
        setStatusOf('open', 0)
        // Соединение могли открыть раньше, чем приехал снапшот: отправляем то, что
        // уже есть. При переподключении это же досылает правки, накопленные в
        // оффлайне, — CRDT-апдейт, а не перезапись состояния.
        const update = Y.encodeStateAsUpdate(doc)
        if (update.byteLength > 0 && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(update)
          } catch {
            /* ignore */
          }
        }
        // Первичная проекция дерева на сервер: у проекта может быть история в
        // CRDT и пустая реляционная модель (после миграции 0002). Роль к этому
        // моменту может быть ещё не известна — тогда проекцию сделает setWritable.
        if (canWrite() && !treeSynced) void syncTree()
      }
      socket.onclose = () => {
        // Событие от уже заменённого сокета игнорируем: повтор планирует только
        // актуальное соединение, поэтому двух серий повторов не бывает.
        if (!active || ws !== socket) return
        ws = null
        setStatusOf(wsOpened ? 'reconnecting' : 'connecting', loop.attempt())
        loop.schedule()
      }
      socket.onerror = () => {
        // События error перед close может не быть вовсе, поэтому статус ставим
        // только здесь, а не планируем повтор: браузер либо пришлёт close, либо
        // переподключение уже запланировано. Иначе на один обрыв пришлось бы две
        // серии повторов и шторм запросов к лежащему серверу.
        if (!active) return
        setStatusOf(wsOpened ? 'reconnecting' : 'connecting', loop.attempt())
      }
      socket.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          applyRemoteUpdate(new Uint8Array(ev.data))
        }
      }
    }

    const loop: ReconnectLoop = createReconnectLoop({
      connect: openSocket,
      onAttemptFailed: (attempt) => {
        // Счётчик показываем уже после третьей неудачи подряд: одна-две — это
        // «мигнуло», а не «realtime тут недоступен».
        const next: CollabStatus = wsOpened || attempt >= OFFLINE_AFTER_ATTEMPTS ? 'reconnecting' : 'connecting'
        setStatusOf(next, attempt)
      },
    })

    /**
     * Проекция дерева с ревизионной защитой.
     *
     * Проекция — полная замена серверного дерева, поэтому устаревший клиент
     * (например, тот, что давно не получал апдейты) сносил чужие строки. Теперь
     * уходит базовая ревизия снапшота (`X-Skyfraze-Base-Revision`) — ровно та же
     * оптимистичная блокировка, что у `PUT /events/state`, и сервер её требует:
     * без заголовка он отвечает 428, при устаревшей базе — 409 и дерево не
     * трогает. Оба случая восстановимые: перечитываем состояние, сливаем его в doc
     * (CRDT не теряет правки) и повторяем проекцию один раз на актуальной базе.
     */
    const syncTree = async (): Promise<SyncTreeResult> => {
      if (!canWrite()) return { ok: false, reason: 'forbidden' }
      const payload = yFlatTree(events)
      if (payload.length === 0) {
        treeSynced = true
        return { ok: true }
      }

      /** Одна попытка. Conflict/428 не бросают: решение принимает вызывающий. */
      const send = async (nodes: FlatEventNode[]) => {
        const result = await syncEventTree(projectId, nodes, revision)
        if (result.conflict) {
          const snapshot = await mergeRemoteState()
          if (snapshot !== null) revision = result.currentRevision ?? snapshot
          else if (result.currentRevision !== undefined) revision = result.currentRevision
          return { ok: false, reason: 'conflict' as const }
        }
        if (result.forbidden) return { ok: false, reason: 'forbidden' as const }
        if (result.needsBase) return { ok: false, reason: 'needsBase' as const }
        return { ok: true as const }
      }

      try {
        const first = await send(payload)
        if (first.ok) {
          treeSynced = true
          return { ok: true }
        }
        if (first.reason === 'forbidden') return first
        if (first.reason === 'conflict' || first.reason === 'needsBase') {
          // Сервер отверг базу. Для 428 её могло просто не быть в руках (снапшот
          // ещё не приехал или запрос состояния упал), для 409 — обогнать успел
          // соавтор. В обоих случаях спасает одно: взять ревизию у сервера.
          if (first.reason === 'needsBase') await mergeRemoteState()
          const retry = await send(yFlatTree(events))
          if (retry.ok) {
            treeSynced = true
            return { ok: true }
          }
          if (retry.reason === 'forbidden') return retry
          // Отвергли и со второго раза — молчать нельзя: иначе страница бодро
          // сообщит «копия обновлена», хотя проекция не прошла.
          return { ok: false, reason: retry.reason === 'conflict' ? 'conflict' : 'error' }
        }
        return first
      } catch (e) {
        const status = httpStatusOf(e)
        if (status === 403) return { ok: false, reason: 'forbidden' }
        if (status === 400) {
          // Сервер отклонил структуру (цикл/сирота/глубина): приводим CRDT
          // к нормализованному виду и повторяем один раз. База у повтора — текущая
          // `revision`: при 400 проекция была отклонена целиком, ревизию снапшота
          // это не меняет. Без заголовка сервер ответил бы 428, и починка
          // иерархии никогда не долетела бы.
          const repaired = yRepairHierarchy(events)
          if (repaired > 0) {
            try {
              const retry = await send(yFlatTree(events))
              if (retry.ok) {
                treeSynced = true
                return { ok: true, repaired }
              }
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
      // Запас с прошлого закрытия вкладки: сначала серверный снапшот, затем
      // отложенный апдейт. Порядок обязателен — слияние идёт поверх серверного
      // состояния, поэтому локальная правка гарантированно в документе.
      deferred = readDeferredState(projectId)
      // ArrayBufferLike, а не ArrayBuffer: у StateSnapshot состояние приходит
      // как Uint8Array<ArrayBufferLike>, у запаса — из base64-декодера.
      let serverState: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
      try {
        const snap = await getEventState(projectId)
        if (!active) return
        revision = snap.revision
        serverState = snap.state
      } catch (e) {
        console.log('[yprovider] snapshot fetch error:', String(e))
      }

      if (!active) return
      if (applyPendingState(doc, serverState, deferred)) {
        // Запас в документе; записать его можно только когда роль известна.
        // Если роль уже пришла и есть соединение — пишем сразу, иначе это
        // сделает `setWritable` или первый успешный debounce-save.
        if (canWrite() && wsOpened) void flushNow()
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

    // Двусторонний канал вкладок одного пользователя (см. broadcast.ts):
    // локальные апдейты уходят соседним вкладкам, чужие приезжают сюда.
    const tabChannel = createTabChannel(projectId, (update) => applyRemoteUpdate(update), doc)
    const detachTabChannel = connectTabChannel(doc, tabChannel)

    // Первое соединение с бэкендом — здесь, а не в конструкторе эффекта: до
    // этого `applyRemoteUpdate`, `loop` и канал вкладок уже определены.
    openSocket()

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingPromise: Promise<void> = Promise.resolve()
    // Сериализация записей снапшота: две собственные параллельные записи
    // (debounce + safety-net) с одной базовой ревизией дают ложный 409.
    let saving = false
    let queued = false

    /**
     * Применить апдейт, пришедший извне (сервер, соседняя вкладка, запас с
     * прошлого закрытия). Origin 'remote' важен: без него `doc.on('update')`
     * счёл бы этот апдейт своим и отправил обратно — бесконечное эхо.
     */
    function applyRemoteUpdate(update: Uint8Array): void {
      if (update.byteLength === 0) return
      try {
        Y.applyUpdate(doc, update, 'remote')
      } catch {
        /* ignore malformed */
      }
    }

    /**
     * Перечитать серверный снапшот и слить его в doc. Возвращает новую ревизию
     * или `null`, если прочитать не удалось: вызывающий тогда решает сам,
     * повторять ли запись. Без этого 409 на проекции дерева оставил бы клиента
     * на устаревшей базе.
     */
    async function mergeRemoteState(): Promise<number | null> {
      try {
        const snap = await getEventState(projectId)
        if (snap.state.byteLength > 0) applyRemoteUpdate(snap.state)
        return snap.revision
      } catch {
        return null
      }
    }

    /**
     * Одна запись снапшота с восстановлением после 409 (см. `commitSnapshot`).
     */
    const doSave = async (): Promise<void> => {
      const result = await commitSnapshot(Y.encodeStateAsUpdate(doc), revision, {
        put: (state, base) => putEventState(projectId, state, base),
        fetchRemote: mergeRemoteState,
        encodeState: () => Y.encodeStateAsUpdate(doc),
      })
      revision = result.revision
      if (!result.ok) return // запас в localStorage остаётся до следующего раза
      // Запас убираем только после подтверждённой записи: иначе он стёрся бы
      // ровно в том случае, ради которого и делался (сеть/конфликт).
      if (shouldClearPending(deferred, Y.encodeStateAsUpdate(doc))) {
        clearDeferredState(projectId)
        deferred = null
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
        /* offline ok: запас в localStorage остаётся до следующего открытия */
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
      // 'remote' — серверный апдейт, 'peer' — апдейт соседней вкладки из
      // BroadcastChannel. Всё внешнее назад не отправляем: это было бы эхо,
      // которое крутится между вкладками бесконечно.
      if (origin === 'remote' || origin === 'peer') return
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
    // Ответ никто не читает: страница уже уходит, и 409/обрыв сети здесь не
    // видны. Поэтому перед отправкой состояние и базовая ревизия кладутся в
    // localStorage — при следующем открытии проекта апдейт сольётся и сохранится.
    // Флаг «сохранить на уходе» больше не зависит от `wsOpened`: клиент без
    // realtime (прокси, мобильная сеть) раньше не сохранял на уходе вообще, и
    // правки терялись молча. Роль `canWrite` уже проверена выше.
    const onUnload = () => {
      if (!active || !canWrite()) return
      const state = Y.encodeStateAsUpdate(doc)
      saveDeferredState(projectId, state, revision, defaultStorage())
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
        }).then((resp) => {
          // Успели получить ответ — запас больше не нужен. Приехал 409 или
          // ошибка — запас остаётся, и следующее открытие проекта применит
          // его через Yjs-слияние.
          if (resp.ok) clearDeferredState(projectId)
        }).catch(() => {/* ignore */})
      } catch { /* ignore */ }
    }
    // `beforeunload` — подстраховка: `pagehide` приходит не во всех сценариях
    // закрытия вкладки (например, часть мобильных браузеров). Обработчик
    // идемпотентен, поэтому двойной вызов ничего не ломает.
    window.addEventListener('pagehide', onUnload)
    window.addEventListener('beforeunload', onUnload)

    /**
     * Страница сообщает роль, когда получила проект. Если запись разрешена и
     * первичная проекция дерева ещё не уходила (её пропустили, пока роль была
     * неизвестна), делаем её здесь — один раз.
     */
    const setWritable = (allowed: boolean | null) => {
      const previous = writable
      writable = allowed
      if (allowed === true && previous !== true && active && !treeSynced) {
        // Отложенный апдейт мог приехать до того, как стала известна роль:
        // сохраняем его теперь, когда запись разрешена.
        if (wsOpened) void syncTree()
        if (deferred) void flushNow()
      }
    }

    setHandle({
      doc,
      events,
      wsUrl: () => wsUrl,
      save,
      flushNow,
      syncTree,
      setWritable,
      connected: false,
      status: 'connecting',
      reconnectAttempt: 0,
    })
    // Контент тянем сразу, не дожидаясь WebSocket (см. loadContent).
    void loadContent()

    return () => {
      active = false
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(safetyNet)
      window.removeEventListener('pagehide', onUnload)
      window.removeEventListener('beforeunload', onUnload)
      loop.stop()
      detachTabChannel()
      // flush делаем ТОЛЬКО если WS-соединение успешно открылось (значит, мы доверенный клиент)
      if (wsOpened && canWrite()) void flushNow()
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [projectId])

  // Состояние соединения живёт отдельно от handle: собираем актуальный объект
  // при отдаче, чтобы интерфейс видел и «переподключаюсь…», и «связи нет».
  return handle ? { ...handle, connected, status, reconnectAttempt } : null
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

/**
 * Слить отложенный апдейт (запас с прошлого закрытия вкладки) с серверным
 * снапшотом. Порядок фиксирован: сначала серверное состояние, потом запас —
 * иначе повторное открытие проекта потеряло бы серверную часть.
 *
 * Возвращает, был ли запас (для решения о записи), и не бросает: сломанный
 * запас не должен ронять страницу проекта.
 */
export function applyPendingState(
  doc: Y.Doc,
  serverState: Uint8Array,
  pending: PendingState | null,
): boolean {
  try {
    if (serverState.byteLength > 0) Y.applyUpdate(doc, serverState, 'remote')
    if (pending) Y.applyUpdate(doc, pending.update, 'remote')
  } catch {
    return false
  }
  return pending !== null
}

/**
 * Пора ли убирать запас из localStorage.
 *
 * Только когда запись подтверждена И содержимое запаса уже внутри сохранённого
 * состояния: иначе пришлось бы либо терять правку (стереть неподтверждённое),
 * либо хранить запас вечно. Сравнение идёт по байтам `encodeStateAsUpdate`:
 * запас — это тот же апдейт, поэтому после слияния он буквально содержится в
 * снапшоте. Зависимости от внутренностей Yjs нет — только от его формата.
 */
export function shouldClearPending(pending: PendingState | null, savedState: Uint8Array): boolean {
  return pending !== null && containsBytes(savedState, pending.update)
}

/** Есть ли `needle` внутри `haystack` как непрерывный фрагмент. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true
  if (needle.byteLength > haystack.byteLength) return false
  const last = haystack.byteLength - needle.byteLength
  outer: for (let at = 0; at <= last; at += 1) {
    for (let i = 0; i < needle.byteLength; i += 1) {
      if (haystack[at + i] !== needle[i]) continue outer
    }
    return true
  }
  return false
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
