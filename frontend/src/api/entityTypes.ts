import { http } from './client'
import { kindLabel } from './entities'

/**
 * Свои типы карточек (0.81.0, docs/entity-types.md).
 *
 * Два поля вместо одного: `key` — машинное имя (латиница, неизменяемое: на него ссылаются
 * карточки, экспорт и помощник), `title` — то, что видит человек («Фракция») и что можно
 * переименовать. Стартовые «Персонаж», «Место», «Тема» есть в каждом проекте и защищены от
 * удаления — их можно переименовать.
 */
export interface EntityType {
  key: string
  title: string
  color: string
  icon: string
  position: number
  is_default: boolean
  created_at: string
}

export async function listEntityTypes(projectId: string): Promise<EntityType[]> {
  const raw = await http
    .get(`projects/${projectId}/entity-types`)
    .json<{ types?: unknown }>()
  const list = Array.isArray(raw?.types) ? raw.types : []
  return list.map(readType).filter((item): item is EntityType => item !== null)
}

export async function createEntityType(
  projectId: string,
  input: { title: string; icon?: string; color?: string },
): Promise<EntityType> {
  const raw = await http
    .post(`projects/${projectId}/entity-types`, {
      json: { title: input.title, icon: input.icon ?? '', color: input.color ?? '' },
    })
    .json<{ type?: unknown }>()
  const type = readType(raw?.type)
  if (type === null) throw new Error('сервер не вернул созданный тип')
  return type
}

export async function updateEntityType(
  projectId: string,
  key: string,
  input: { title: string; icon?: string; color?: string },
): Promise<EntityType> {
  const raw = await http
    .patch(`projects/${projectId}/entity-types/${encodeURIComponent(key)}`, {
      json: { title: input.title, icon: input.icon ?? '', color: input.color ?? '' },
    })
    .json<{ type?: unknown }>()
  const type = readType(raw?.type)
  if (type === null) throw new Error('сервер не вернул тип после правки')
  return type
}

export async function deleteEntityType(projectId: string, key: string): Promise<void> {
  await http.delete(`projects/${projectId}/entity-types/${encodeURIComponent(key)}`)
}

/**
 * Название вида для человека.
 *
 * Если тип не найден в списке (данные ещё едут или тип удалили в другой вкладке), показываем
 * стартовую подпись, а для неизвестного ключа — сам ключ. Подставлять «Персонаж» по умолчанию
 * нельзя: это было бы неправдой о данных.
 */
export function typeTitle(types: EntityType[], key: string): string {
  const found = types.find((item) => item.key === key)
  if (found) return found.title
  if (key === 'character' || key === 'place' || key === 'theme') return kindLabel(key)
  return key
}

/** Цвет типа — для подсветки карточки, если у самой карточки цвет не задан. */
export function typeColor(types: EntityType[], key: string): string {
  return types.find((item) => item.key === key)?.color ?? ''
}

function readType(raw: unknown): EntityType | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const key = typeof record.key === 'string' ? record.key : ''
  const title = typeof record.title === 'string' ? record.title : ''
  if (!key || !title) return null
  return {
    key,
    title,
    color: typeof record.color === 'string' ? record.color : '',
    icon: typeof record.icon === 'string' ? record.icon : '',
    position: typeof record.position === 'number' ? record.position : 0,
    is_default: record.is_default === true,
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
}
