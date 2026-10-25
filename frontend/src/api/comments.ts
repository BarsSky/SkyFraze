import { http } from './client'

/**
 * Обсуждение кадров.
 *
 * Комментарий — разговор о кадре, а не часть кадра: он не попадает ни в книгу, ни в
 * Markdown-выгрузку, ни в CRDT-документ. Поэтому здесь обычные REST-запросы, без сокета:
 * обсуждение не обязано быть живым, а «перечитал кадр — увидел новые замечания» честно
 * описывает то, что происходит.
 */

export interface FrameComment {
  id: string
  eventId: string
  userId: string
  /** Имя автора с сервера: в интерфейсе нужен человек, а не UUID. */
  authorName: string
  body: string
  createdAt: string
}

/** Сколько комментариев у каждого кадра: ключ — идентификатор кадра. */
export type CommentCounts = Record<string, number>

export async function listComments(
  projectId: string,
  eventId: string,
): Promise<FrameComment[]> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/comments`, {
      searchParams: { event_id: eventId },
    })
    .json<unknown>()
  return parseComments(raw)
}

export async function commentCounts(projectId: string): Promise<CommentCounts> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/comments/counts`)
    .json<unknown>()
  return parseCounts(raw)
}

export async function createComment(
  projectId: string,
  eventId: string,
  body: string,
): Promise<FrameComment | null> {
  const raw = await http
    .post(`projects/${encodeURIComponent(projectId)}/comments`, {
      json: { event_id: eventId, body },
    })
    .json<unknown>()
  const record = asRecord(raw)
  return parseComment(record?.comment)
}

export async function deleteComment(projectId: string, commentId: string): Promise<void> {
  await http.delete(
    `projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}`,
  )
}

// ── разбор ответов ──────────────────────────────────────────────────────
// Сервер — внешний источник: «поля не пришло» даёт пустой список, а не падение разметки.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asWhole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function parseComment(raw: unknown): FrameComment | null {
  const record = asRecord(raw)
  const id = asText(record?.id)
  const eventId = asText(record?.event_id)
  if (!id || !eventId) return null
  return {
    id,
    eventId,
    userId: asText(record?.user_id),
    authorName: asText(record?.author_name),
    body: asText(record?.body),
    createdAt: asText(record?.created_at),
  }
}

export function parseComments(raw: unknown): FrameComment[] {
  const record = asRecord(raw)
  if (!Array.isArray(record?.comments)) return []
  const out: FrameComment[] = []
  for (const item of record.comments) {
    const comment = parseComment(item)
    if (comment !== null) out.push(comment)
  }
  return out
}

export function parseCounts(raw: unknown): CommentCounts {
  const record = asRecord(raw)
  const counts = asRecord(record?.counts)
  const out: CommentCounts = {}
  if (!counts) return out
  for (const [eventId, value] of Object.entries(counts)) {
    const n = asWhole(value)
    if (n > 0) out[eventId] = n
  }
  return out
}
