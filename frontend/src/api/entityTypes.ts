import { http } from './client'
import { tStatic } from '../i18n'
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
  /**
   * Заготовка карточки этого типа (0.85.0): описание с подстановкой `{{name}}` и типичные
   * алиасы. Пустые значения — «заготовки нет», это норма для большинства типов.
   */
  card_template?: EntityCardTemplate
  created_at: string
}

/** Заготовка карточки у типа (0.85.0, миграция 0035). */
export interface EntityCardTemplate {
  description?: string
  aliases?: string[]
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
  input: { title: string; icon?: string; color?: string; cardTemplate?: EntityCardTemplate },
): Promise<EntityType> {
  const raw = await http
    .post(`projects/${projectId}/entity-types`, {
      json: {
        title: input.title,
        icon: input.icon ?? '',
        color: input.color ?? '',
        ...(input.cardTemplate ? { card_template: input.cardTemplate } : {}),
      },
    })
    .json<{ type?: unknown }>()
  const type = readType(raw?.type)
  if (type === null) throw new Error(tStatic('api.errNoType'))
  return type
}

export async function updateEntityType(
  projectId: string,
  key: string,
  input: { title: string; icon?: string; color?: string; cardTemplate?: EntityCardTemplate },
): Promise<EntityType> {
  const raw = await http
    .patch(`projects/${projectId}/entity-types/${encodeURIComponent(key)}`, {
      json: {
        title: input.title,
        icon: input.icon ?? '',
        color: input.color ?? '',
        // Заготовку отправляем всегда (в том числе пустую): PATCH присылает полный объект, и
        // «не прислали» здесь означало бы «оставь как было» — а стереть заготовку тоже нужно.
        card_template: input.cardTemplate ?? {},
      },
    })
    .json<{ type?: unknown }>()
  const type = readType(raw?.type)
  if (type === null) throw new Error(tStatic('api.errNoTypeAfterEdit'))
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
    card_template: readCardTemplate(record.card_template),
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
  }
}

/** Заготовка карточки из ответа сервера: лишние поля не переносим, мусор отбрасываем. */
function readCardTemplate(raw: unknown): EntityCardTemplate {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const description = typeof record.description === 'string' ? record.description : ''
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((item): item is string => typeof item === 'string')
    : []
  return { description, aliases }
}

/**
 * Что подставить в форму новой карточки этого типа (0.85.0).
 *
 * `{{name}}` заменяется на введённое имя; пустое имя оставляет текст как есть — человек ещё не
 * решил, кого заводит, и «{{name}}» в поле лучше пустоты: видно, куда это попадёт.
 */
export function cardTemplateFor(
  types: EntityType[],
  key: string,
  name: string,
): { description: string; aliases: string } {
  const template = types.find((item) => item.key === key)?.card_template
  if (!template) return { description: '', aliases: '' }
  const cleanName = name.trim()
  const description = cleanName === ''
    ? template.description ?? ''
    : (template.description ?? '').replaceAll('{{name}}', cleanName)
  return { description, aliases: (template.aliases ?? []).join(', ') }
}
