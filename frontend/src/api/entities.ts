import { http } from './client'

/**
 * Карточки сущностей проекта: персонажи, места, темы (docs/entity-links.md).
 *
 * Зачем карточки, а не теги: тег не имеет идентичности, поэтому «Анна», «Анны» и «Аня» —
 * это три тега или ни одного. Карточка — это одно имя плюс алиасы, и по ней считается
 * «где на таймлайне появляется Анна».
 */

export type EntityKind = 'character' | 'place' | 'theme'

export interface ProjectEntity {
  id: string
  kind: EntityKind
  name: string
  aliases: string[]
  description: string
  color: string
  created_at: string
  updated_at: string
}

/** Что можно задать при создании и правке (поля необязательные — «не прислали — не меняем»). */
export interface EntityInput {
  kind?: EntityKind
  name?: string
  aliases?: string[]
  description?: string
  color?: string
}

export async function listEntities(projectId: string): Promise<ProjectEntity[]> {
  const raw = await http
    .get(`projects/${projectId}/entities`)
    .json<{ entities?: unknown }>()
  const list = Array.isArray(raw?.entities) ? raw.entities : []
  return list.map(readEntity).filter((entity): entity is ProjectEntity => entity !== null)
}

export async function createEntity(
  projectId: string,
  input: EntityInput,
): Promise<ProjectEntity> {
  const raw = await http
    .post(`projects/${projectId}/entities`, { json: input })
    .json<{ entity?: unknown }>()
  const entity = readEntity(raw?.entity)
  if (entity === null) throw new Error('сервер не вернул карточку')
  return entity
}

export async function updateEntity(
  projectId: string,
  id: string,
  input: EntityInput,
): Promise<ProjectEntity> {
  const raw = await http
    .patch(`projects/${projectId}/entities/${encodeURIComponent(id)}`, { json: input })
    .json<{ entity?: unknown }>()
  const entity = readEntity(raw?.entity)
  if (entity === null) throw new Error('сервер не вернул карточку')
  return entity
}

export async function deleteEntity(projectId: string, id: string): Promise<void> {
  await http.delete(`projects/${projectId}/entities/${encodeURIComponent(id)}`)
}

/**
 * Разбор ответа сервера.
 *
 * Алиасы нормализуются в массив: сервер отдаёт `[]`, но поле может прийти и отсутствующим
 * (карточка, созданная до появления алиасов), а `undefined` в интерфейсе означал бы «упало
 * на .map».
 */
export function readEntity(raw: unknown): ProjectEntity | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (!id || !name) return null
  const kind = record.kind === 'place' || record.kind === 'theme' ? record.kind : 'character'
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((alias): alias is string => typeof alias === 'string' && alias !== '')
    : []
  return {
    id,
    kind,
    name,
    aliases,
    description: typeof record.description === 'string' ? record.description : '',
    color: typeof record.color === 'string' ? record.color : '',
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : '',
  }
}

/** Вид сущности по-русски: в интерфейсе не должно быть `character`. */
export function kindLabel(kind: EntityKind): string {
  switch (kind) {
    case 'place':
      return 'Место'
    case 'theme':
      return 'Тема'
    default:
      return 'Персонаж'
  }
}

/** «Анна, Аня, Анны» — алиасы одной строкой (для списка и подсказок). */
export function aliasesText(entity: ProjectEntity): string {
  return entity.aliases.join(', ')
}
