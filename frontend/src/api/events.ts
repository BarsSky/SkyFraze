import { http } from './client'

/**
 * REST-контракт событий проекта.
 *
 * Серверная модель иерархии: `events.parent_id` + `depth` + `position`.
 * Клиент по-прежнему рисует таймлайн из CRDT (Yjs), но структуру дерева
 * проецирует на сервер (`syncEventTree`) — там она проверяется на циклы,
 * глубину и принадлежность проекту. CRDT-снапшот живёт отдельно и
 * версионируется ревизией (оптимистичная блокировка).
 */

/**
 * Заголовки ревизии снапшота. Тот же контракт, что у `/events/state`, и у
 * проекции дерева: клиент присылает базу, которую видел последней, сервер
 * отдаёт актуальную (при 409 — вместе с ошибкой).
 */
export const BASE_REVISION_HEADER = 'X-Skyfraze-Base-Revision'
export const REVISION_HEADER = 'X-Skyfraze-Revision'

export interface EventNode {
  id: string
  project_id: string
  parent_id: string | null
  position: number
  depth: number
  title: string
  body: string
  event_date?: string | null
  updated_at?: string
  children: EventNode[]
}

/** Плоский узел для проекции дерева (id задаёт клиент). */
export interface FlatEventNode {
  id: string
  parent_id: string | null
  position?: number
  title: string
  body: string
}

export async function listEventTree(projectId: string): Promise<EventNode[]> {
  return await http.get(`projects/${projectId}/events`).json<EventNode[]>()
}

/** Плоский список событий проекта (обход дерева в порядке отображения). */
export async function listEventRows(projectId: string): Promise<FlatEventNode[]> {
  const tree = await listEventTree(projectId)
  const out: FlatEventNode[] = []
  const walk = (nodes: EventNode[]) => {
    for (const n of nodes) {
      out.push({
        id: n.id,
        parent_id: n.parent_id ?? null,
        position: n.position,
        title: n.title ?? '',
        body: n.body ?? '',
      })
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/**
 * Результат проекции дерева.
 *
 * Проекция — полная замена серверного дерева, поэтому она защищена той же
 * оптимистичной блокировкой, что и снапшот: без базовой ревизии устаревший
 * клиент сносил чужие строки. Теперь клиент присылает `X-Skyfraze-Base-Revision`
 * (сервер его требует: 428 без заголовка), а при 409 (`conflict`) перечитывает
 * состояние и повторяет один раз — ровно как в `putEventState`.
 */
export interface SyncTreeResult {
  /** Сервер отклонил проекцию: базовая ревизия устарела, нужен merge и повтор. */
  conflict?: boolean
  /** Актуальная ревизия сервера (при конфликте). */
  currentRevision?: number
  /** Роль не позволяет менять таймлайн. */
  forbidden?: boolean
  /**
   * 428 Precondition Required: сервер требует `X-Skyfraze-Base-Revision`, а мы его
   * не отправили (база ещё не получена). Случай восстановимый: взять ревизию
   * (`getEventState`) и повторить — иначе проекция не пройдёт никогда.
   */
  needsBase?: boolean
}

/** Ошибка запроса с HTTP-статусом: нужна, чтобы отличить 400 от 403/409. */
export interface HttpStatusError extends Error {
  status: number
}

export function httpStatusOf(error: unknown): number | null {
  const response = (error as { response?: { status?: number } } | null)?.response
  if (response && typeof response.status === 'number') return response.status
  const status = (error as { status?: number } | null)?.status
  return typeof status === 'number' ? status : null
}

/**
 * Проекция дерева на сервер.
 *
 * `baseRevision` обязателен: сервер требует заголовок и без него отвечает 428,
 * потому что иначе проекция (полная замена) затирала бы чужие строки. Если базы
 * ещё нет, передавайте 0 — тогда сервер честно ответит 409 и актуальной
 * ревизией, и вызывающий повторит на ней.
 */
export async function syncEventTree(
  projectId: string,
  nodes: FlatEventNode[],
  baseRevision: number,
): Promise<SyncTreeResult> {
  const resp = await http.put(`projects/${projectId}/events/tree`, {
    json: nodes,
    headers: { [BASE_REVISION_HEADER]: String(baseRevision) },
    // 409/428 — не исключение, а часть протокола: их разбирает вызывающий.
    throwHttpErrors: false,
  })

  if (resp.status === 409) {
    const revision = Number(resp.headers.get(REVISION_HEADER) ?? '')
    return {
      conflict: true,
      currentRevision: Number.isFinite(revision) && revision > 0 ? revision : undefined,
    }
  }
  // 428 — симметрия с PUT /events/state: сервер требует базовую ревизию.
  if (resp.status === 428) return { needsBase: true }
  if (resp.status === 403) return { forbidden: true }
  if (!resp.ok) {
    // Статус нужен вызывающему: 400 = структуру отклонят и после повтора,
    // 5xx/сеть = временная ошибка. Раньше это различалось через брошенный
    // HTTPError, и весь остальной код полагается на такое поведение.
    const error = new Error(`events/tree: ${resp.status}`) as HttpStatusError
    error.status = resp.status
    throw error
  }
  return {}
}

export async function createEvent(
  projectId: string,
  input: { id?: string; parent_id?: string | null; title?: string; body?: string },
): Promise<EventNode> {
  return await http.post(`projects/${projectId}/events`, { json: input }).json<EventNode>()
}

export async function patchEvent(
  projectId: string,
  eventId: string,
  input: { title?: string; body?: string },
): Promise<EventNode> {
  return await http.patch(`projects/${projectId}/events/${eventId}`, { json: input }).json<EventNode>()
}

export async function moveEvent(
  projectId: string,
  eventId: string,
  input: { parent_id: string | null; position?: number },
): Promise<EventNode> {
  return await http
    .put(`projects/${projectId}/events/${eventId}/parent`, { json: input })
    .json<EventNode>()
}

export async function deleteEvent(projectId: string, eventId: string): Promise<number> {
  const resp = await http.delete(`projects/${projectId}/events/${eventId}`).json<{ removed: number }>()
  return resp.removed
}

// ── CRDT-снапшот (с ревизией) ───────────────────────────────────────────────

export interface StateSnapshot {
  state: Uint8Array
  revision: number
}

export async function getEventState(projectId: string): Promise<StateSnapshot> {
  const resp = await http.get(`projects/${projectId}/events/state`, {
    headers: { Accept: 'application/octet-stream' },
  })
  const revision = Number(resp.headers.get(REVISION_HEADER) ?? '0') || 0
  const buf = await resp.arrayBuffer()
  return { state: new Uint8Array(buf), revision }
}

export interface PutStateResult {
  ok: boolean
  /** новая ревизия при успехе */
  revision?: number
  /** сервер отклонил запись: базовая ревизия устарела */
  conflict?: boolean
  /** актуальная ревизия сервера (при конфликте) */
  currentRevision?: number
}

export async function putEventState(
  projectId: string,
  state: Uint8Array,
  baseRevision: number,
): Promise<PutStateResult> {
  // Uint8Array<ArrayBufferLike> → Uint8Array<ArrayBuffer> через копию
  const safe = new Uint8Array(new ArrayBuffer(state.byteLength))
  safe.set(state)
  const resp = await http.put(`projects/${projectId}/events/state`, {
    headers: {
      'Content-Type': 'application/octet-stream',
      [BASE_REVISION_HEADER]: String(baseRevision),
    },
    body: new Blob([safe]),
    throwHttpErrors: false,
  })
  if (resp.status === 409) {
    return {
      ok: false,
      conflict: true,
      currentRevision: Number(resp.headers.get(REVISION_HEADER) ?? '') || undefined,
    }
  }
  if (!resp.ok) {
    return { ok: false }
  }
  return { ok: true, revision: Number(resp.headers.get(REVISION_HEADER) ?? '') || baseRevision + 1 }
}
