import { http } from './client'

/**
 * Картинка у упоминания карточки в кадре (0.93.0, docs/entity-links.md §3.4.1).
 *
 * Фича: в карточке упоминания привязывается вложение проекта — «как это выглядит» (портрет
 * персонажа, вид места, обложка темы). Одна картинка на пару «карточка × кадр»: несколько
 * превратили бы карточку в галерею.
 *
 * Сервер отдаёт привязки ОДНИМ списком на проект: панель «Связи» показывает карточки всех
 * персонажей сразу, и запрос на каждую пару означал бы N обращений ради одного экрана.
 * В интерфейсе список превращается в словарь `ключ → id вложения` (см. `mentionImageKey`).
 */

export interface MentionImage {
  entity_id: string
  event_id: string
  asset_id: string
}

/** Ключ пары в словаре: одна и та же карточка в разных кадрах — разные картинки. */
export function mentionImageKey(entityId: string, eventId: string): string {
  return `${entityId}:${eventId}`
}

export async function listMentionImages(projectId: string): Promise<Record<string, string>> {
  const raw = await http.get(`projects/${projectId}/mention-images`).json<{ images?: unknown }>()
  const list = Array.isArray(raw?.images) ? raw.images : []
  const out: Record<string, string> = {}
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const entityId = typeof record.entity_id === 'string' ? record.entity_id : ''
    const eventId = typeof record.event_id === 'string' ? record.event_id : ''
    const assetId = typeof record.asset_id === 'string' ? record.asset_id : ''
    if (!entityId || !eventId || !assetId) continue
    out[mentionImageKey(entityId, eventId)] = assetId
  }
  return out
}

/** Привязать картинку к паре (заменяет прежнюю). */
export async function setMentionImage(
  projectId: string,
  entityId: string,
  eventId: string,
  assetId: string,
): Promise<void> {
  await http
    .put(`projects/${projectId}/mention-images/${entityId}/${eventId}`, { json: { asset_id: assetId } })
    .json()
}

/** Отвязать картинку. Повторная отвязка не ошибка. */
export async function clearMentionImage(
  projectId: string,
  entityId: string,
  eventId: string,
): Promise<void> {
  await http.delete(`projects/${projectId}/mention-images/${entityId}/${eventId}`).json()
}
