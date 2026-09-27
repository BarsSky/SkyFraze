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

export async function syncEventTree(projectId: string, nodes: FlatEventNode[]): Promise<EventNode[]> {
  return await http.put(`projects/${projectId}/events/tree`, { json: nodes }).json<EventNode[]>()
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
  const revision = Number(resp.headers.get('X-Skyfraze-Revision') ?? '0') || 0
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
      'X-Skyfraze-Base-Revision': String(baseRevision),
    },
    body: new Blob([safe]),
    throwHttpErrors: false,
  })
  if (resp.status === 409) {
    return {
      ok: false,
      conflict: true,
      currentRevision: Number(resp.headers.get('X-Skyfraze-Revision') ?? '') || undefined,
    }
  }
  if (!resp.ok) {
    return { ok: false }
  }
  return { ok: true, revision: Number(resp.headers.get('X-Skyfraze-Revision') ?? '') || baseRevision + 1 }
}
