import { http } from './client'

/**
 * Карточки сущностей проекта: персонажи, места, темы (docs/entity-links.md).
 *
 * Зачем карточки, а не теги: тег не имеет идентичности, поэтому «Анна», «Анны» и «Аня» —
 * это три тега или ни одного. Карточка — это одно имя плюс алиасы, и по ней считается
 * «где на таймлайне появляется Анна».
 */

/**
 * Стартовые виды карточек. С 0.81.0 вид — не перечисление, а ключ ТИПА из проекта
 * (`src/api/entityTypes.ts`): у каждой книги свои «Фракции» и «Артефакты». Тип оставлен ради
 * мест, где речь именно о трёх стартовых (подписи по умолчанию, обратная совместимость).
 */
export type EntityKind = 'character' | 'place' | 'theme'

export interface ProjectEntity {
  id: string
  /** Ключ типа: стартовый (`character`/`place`/`theme`) или свой из проекта (0.81.0). */
  kind: string
  name: string
  aliases: string[]
  description: string
  color: string
  created_at: string
  updated_at: string
}

/** Что можно задать при создании и правке (поля необязательные — «не прислали — не меняем»). */
export interface EntityInput {
  kind?: string
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
  // Вид — ключ ТИПА карточки (0.81.0), а не перечисление: «Фракция» приходит с сервера как
  // `frakciya`, и приводить её к «character» значило бы терять тип при разборе ответа (этим и
  // объяснялось «создал тип, а карточка всё равно персонаж»). Храним строку как есть; подпись
  // для человека берёт `typeTitle` из типов проекта.
  const kind = typeof record.kind === 'string' ? record.kind : ''
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

/**
 * Русское название СТАРТОВОГО вида карточки.
 *
 * С 0.81.0 виды — это типы проекта (`api/entityTypes.ts`), и правильная подпись берётся из
 * `typeTitle`. Здесь только три стартовых ключа; для любого другого возвращаем ключ КАК ЕСТЬ, а
 * не «Персонаж»: подставлять стартовую подпись — значит врать о данных (у человека «Фракция»
 * стала бы персонажем в отчётах и предложениях помощника).
 */
export function kindLabel(kind: EntityKind | string): string {
  switch (kind) {
    case 'character':
      return 'Персонаж'
    case 'place':
      return 'Место'
    case 'theme':
      return 'Тема'
    default:
      return kind
  }
}

/** «Анна, Аня, Анны» — алиасы одной строкой (для списка и подсказок). */
export function aliasesText(entity: ProjectEntity): string {
  return entity.aliases.join(', ')
}

/** Связь двух карточек: «Аня — живёт на → Земля» (миграция 0032). */
export interface EntityLink {
  id: string
  from_entity: string
  to_entity: string
  label: string
  created_at: string
}

export async function listEntityLinks(projectId: string): Promise<EntityLink[]> {
  const raw = await http.get(`projects/${projectId}/entities/links`).json<{ links?: unknown }>()
  const list = Array.isArray(raw?.links) ? raw.links : []
  const out: EntityLink[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const from = typeof record.from_entity === 'string' ? record.from_entity : ''
    const to = typeof record.to_entity === 'string' ? record.to_entity : ''
    const label = typeof record.label === 'string' ? record.label : ''
    if (!id || !from || !to) continue
    out.push({
      id,
      from_entity: from,
      to_entity: to,
      label,
      created_at: typeof record.created_at === 'string' ? record.created_at : '',
    })
  }
  return out
}

export async function addEntityLink(
  projectId: string,
  fromId: string,
  toId: string,
  label: string,
): Promise<EntityLink> {
  const raw = await http
    .post(`projects/${projectId}/entities/${encodeURIComponent(fromId)}/links`, {
      json: { to: toId, label },
    })
    .json<{ link?: EntityLink }>()
  if (!raw?.link) throw new Error('сервер не вернул связь')
  return raw.link
}

export async function deleteEntityLink(projectId: string, linkId: string): Promise<void> {
  await http.delete(`projects/${projectId}/entities/links/${encodeURIComponent(linkId)}`)
}

/** Связи карточки в обе стороны: с подписью и с тем, кто на другом конце. */
export interface EntityConnection {
  link: EntityLink
  /** Карточка на другом конце. */
  other: ProjectEntity
  /** Направление: «→» — от этой карточки, «←» — к этой. */
  direction: 'out' | 'in'
}

/** Собирает связи одной карточки: чипы показывают обе стороны. */
export function connectionsOf(
  entityId: string,
  links: EntityLink[],
  entities: ProjectEntity[],
): EntityConnection[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const out: EntityConnection[] = []
  for (const link of links) {
    if (link.from_entity === entityId) {
      const other = byId.get(link.to_entity)
      if (other) out.push({ link, other, direction: 'out' })
    } else if (link.to_entity === entityId) {
      const other = byId.get(link.from_entity)
      if (other) out.push({ link, other, direction: 'in' })
    }
  }
  return out
}
