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
  /** Замечание, на которое это ответ (миграция 0023). У корневых — null. */
  parentId: string | null
  /**
   * Комментарий удалён автором: строка осталась, тело вычищено, ответы на неё живы.
   * Удаление мягкое намеренно — иначе вместе с замечанием пропали бы чужие ответы.
   */
  deleted: boolean
  /** Реакции: сколько «согласен»/«сделано» и какие из них мои (миграция 0025). */
  reactions: CommentReactions
  /** Замечание к фрагменту текста (0026). null — замечание к кадру целиком. */
  anchor: FrameAnchor | null
}

/** Реакции на замечание. Два вида, оба про работу, а не про человека. */
export interface CommentReactions {
  agree: number
  done: number
  mine: string[]
}

/**
 * Якорь замечания к фрагменту текста (миграция 0026). Позиции — base64 от
 * `Y.encodeRelativePosition`: резолвятся в живом документе, поэтому переживают чужие правки
 * (docs/fragment-comments.md).
 */
export interface FrameAnchor {
  field: string
  start: string
  end: string
  /** Что было выделено: нужно, когда якорь больше не резолвится. */
  quote: string
}

/** Вид реакции: «согласен» (принято к работе) и «сделано» (правка внесена). */
export type ReactionKind = 'agree' | 'done'

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
  /**
   * Ответ на замечание. Ветка одноуровневая: сервер отвергает ответ на ответ, поэтому
   * сюда попадает только идентификатор корневого замечания.
   */
  parentId?: string | null,
  /** Замечание к фрагменту: позиции считает клиент, он один видит живой документ. */
  anchor?: FrameAnchor | null,
): Promise<FrameComment | null> {
  const json: Record<string, unknown> = { event_id: eventId, body }
  if (parentId) json.parent_id = parentId
  if (anchor) json.anchor = anchor
  const raw = await http
    .post(`projects/${encodeURIComponent(projectId)}/comments`, { json })
    .json<unknown>()
  const record = asRecord(raw)
  return parseComment(record?.comment)
}

export async function deleteComment(projectId: string, commentId: string): Promise<void> {
  await http.delete(
    `projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}`,
  )
}

/**
 * Поставить или снять реакцию. Явные PUT/DELETE, а не переключатель: повтор запроса безопасен,
 * и двойное нажатие на телефоне не превращается в «поставил и снял».
 *
 * Возвращаются счётчики после изменения — их считает сервер, чтобы интерфейс не разошёлся с ним.
 */
export async function setCommentReaction(
  projectId: string,
  commentId: string,
  kind: ReactionKind,
  on: boolean,
): Promise<CommentReactions> {
  const path = `projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}/reactions/${kind}`
  const raw = on
    ? await http.put(path).json<unknown>()
    : await http.delete(path).json<unknown>()
  return parseReactions(asRecord(raw)?.reactions)
}

/** Непрочитанные замечания по кадрам проекта: ключ — кадр, значение — сколько новых. */
export type UnseenComments = Record<string, number>

export async function unseenComments(projectId: string): Promise<UnseenComments> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/comments/unseen`)
    .json<unknown>()
  return parseUnseen(raw)
}

/** Отметить обсуждение кадра прочитанным — вызывается, когда оно показано. */
export async function markCommentsSeen(projectId: string, eventId: string): Promise<void> {
  await http.post(`projects/${encodeURIComponent(projectId)}/comments/seen`, {
    json: { event_id: eventId },
  })
}

/** Проект с непрочитанными замечаниями — строка списка проектов. */
export interface ProjectUnseen {
  projectId: string
  title: string
  unread: number
  /**
   * Сколько из этих непрочитанных адресованы мне (`@ник`). «В проекте что-то новое» и «в
   * проекте позвали меня» — разные новости: первое можно отложить, второе обычно нельзя.
   */
  mentions: number
  lastAt: string
}

export async function projectsWithUnseen(): Promise<ProjectUnseen[]> {
  const raw = await http.get('comments/unseen').json<unknown>()
  return parseProjectUnseen(raw)
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
  const parentId = asText(record?.parent_id)
  return {
    id,
    eventId,
    userId: asText(record?.user_id),
    authorName: asText(record?.author_name),
    body: asText(record?.body),
    createdAt: asText(record?.created_at),
    parentId: parentId === '' ? null : parentId,
    deleted: record?.deleted === true,
    reactions: parseReactions(record?.reactions),
    anchor: parseAnchor(record?.anchor),
  }
}

/** Разбор якоря: нет поля или нет позиций — замечание к кадру, а не падение разметки. */
export function parseAnchor(raw: unknown): FrameAnchor | null {
  const record = asRecord(raw)
  const start = asText(record?.start)
  const end = asText(record?.end)
  if (!start || !end) return null
  return {
    field: asText(record?.field) || 'body',
    start,
    end,
    quote: asText(record?.quote),
  }
}

/** Разбор реакций: нет поля — ноль реакций, а не падение разметки. */
export function parseReactions(raw: unknown): CommentReactions {
  const record = asRecord(raw)
  const mine = Array.isArray(record?.mine)
    ? record.mine.filter((value): value is string => typeof value === 'string')
    : []
  return {
    agree: asWhole(record?.agree),
    done: asWhole(record?.done),
    mine,
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

/** Разбор непрочитанного: сервер отдаёт список строк «кадр — сколько — когда». */
export function parseUnseen(raw: unknown): UnseenComments {
  const record = asRecord(raw)
  if (!Array.isArray(record?.unseen)) return {}
  const out: UnseenComments = {}
  for (const item of record.unseen) {
    const row = asRecord(item)
    const eventId = asText(row?.event_id)
    const n = asWhole(row?.unread)
    if (eventId && n > 0) out[eventId] = n
  }
  return out
}

export function parseProjectUnseen(raw: unknown): ProjectUnseen[] {
  const record = asRecord(raw)
  if (!Array.isArray(record?.projects)) return []
  const out: ProjectUnseen[] = []
  for (const item of record.projects) {
    const row = asRecord(item)
    const projectId = asText(row?.project_id)
    const unread = asWhole(row?.unread)
    if (!projectId || unread <= 0) continue
    out.push({
      projectId,
      title: asText(row?.title),
      unread,
      mentions: asWhole(row?.mentions),
      lastAt: asText(row?.last_at),
    })
  }
  return out
}
