import { http } from './client'

/**
 * История версий проекта.
 *
 * Версия — снапшот CRDT-документа целиком (кадры, тексты, даты, вложения, фон). В отличие
 * от резервной копии она снимается по ходу работы и позволяет вернуть ОДИН проект,
 * не разворачивая дамп: «верни как было час назад».
 */

export interface ProjectVersion {
  id: string
  /** `auto` — снял сервер по ходу правок, `manual` — человек нажал «Сохранить версию». */
  kind: string
  label: string
  events: number
  /** Размер снапшота в байтах: по нему видно, чего стоит история. */
  size: number
  createdAt: string
  createdBy: string | null
}

/** Один кадр в предпросмотре версии. */
export interface ProjectVersionFrame {
  id: string
  depth: number
  title: string
  date: string
  chars: number
}

export interface ProjectVersionPreview {
  version: ProjectVersion
  frames: ProjectVersionFrame[]
  /** Сколько всего знаков текста в версии. */
  chars: number
}

/** Что изменилось при восстановлении. */
export interface ProjectRestoreResult {
  removed: number
  added: number
  updated: number
  moved: number
  warning: string
}

export async function listProjectVersions(
  projectId: string,
  limit = 50,
): Promise<ProjectVersion[]> {
  const raw = await http
    .get(`projects/${encodeURIComponent(projectId)}/versions`, {
      searchParams: { limit: String(limit) },
    })
    .json<unknown>()
  return parseVersions(raw)
}

/** Ручная версия: снимается сразу и не уходит по удержанию раньше автоснимков. */
export async function saveProjectVersion(
  projectId: string,
  label: string,
): Promise<ProjectVersion | null> {
  const raw = await http
    .post(`projects/${encodeURIComponent(projectId)}/versions`, {
      json: { label },
      timeout: 30000,
    })
    .json<unknown>()
  return parseVersion(raw)
}

export async function getProjectVersion(
  projectId: string,
  versionId: string,
): Promise<ProjectVersionPreview | null> {
  const raw = await http
    .get(
      `projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
    )
    .json<unknown>()
  return parsePreview(raw)
}

/**
 * Восстановить проект к версии.
 *
 * Сервер приводит документ к состоянию версии обычным апдейтом, поэтому открытые вкладки
 * видят результат сразу. Возвращённые счётчики — что именно изменилось.
 */
export async function restoreProjectVersion(
  projectId: string,
  versionId: string,
): Promise<ProjectRestoreResult> {
  const raw = await http
    .post(
      `projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { timeout: 60000 },
    )
    .json<unknown>()
  return parseRestoreResult(raw)
}

export async function deleteProjectVersion(projectId: string, versionId: string): Promise<void> {
  await http.delete(
    `projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
  )
}

// ── разбор ответов ──────────────────────────────────────────────────────
// Сервер — внешний источник: «поля не пришло» должно давать пустой список, а не падение
// разметки.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asWhole(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function parseVersions(raw: unknown): ProjectVersion[] {
  const record = asRecord(raw)
  if (!Array.isArray(record?.versions)) return []
  const out: ProjectVersion[] = []
  for (const item of record.versions) {
    const version = parseVersion(item)
    if (version !== null) out.push(version)
  }
  return out
}

export function parseVersion(raw: unknown): ProjectVersion | null {
  const record = asRecord(raw)
  const id = asText(record?.id)
  if (!id) return null
  const createdBy = asText(record?.created_by)
  return {
    id,
    kind: asText(record?.kind) || 'auto',
    label: asText(record?.label),
    events: asWhole(record?.events),
    size: asWhole(record?.size),
    createdAt: asText(record?.created_at),
    createdBy: createdBy === '' ? null : createdBy,
  }
}

export function parsePreview(raw: unknown): ProjectVersionPreview | null {
  const record = asRecord(raw)
  const version = parseVersion(record?.version)
  if (version === null) return null
  const frames: ProjectVersionFrame[] = []
  if (Array.isArray(record?.frames)) {
    for (const item of record.frames) {
      const frame = asRecord(item)
      const id = asText(frame?.id)
      if (!id) continue
      frames.push({
        id,
        depth: asWhole(frame?.depth),
        title: asText(frame?.title),
        date: asText(frame?.date),
        chars: asWhole(frame?.chars),
      })
    }
  }
  return { version, frames, chars: asWhole(record?.chars) }
}

export function parseRestoreResult(raw: unknown): ProjectRestoreResult {
  const record = asRecord(raw)
  return {
    removed: asWhole(record?.removed),
    added: asWhole(record?.added),
    updated: asWhole(record?.updated),
    moved: asWhole(record?.moved),
    warning: asText(record?.warning),
  }
}
