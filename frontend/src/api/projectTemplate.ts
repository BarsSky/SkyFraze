import { http } from './client'
import { tStatic } from '../i18n'

/**
 * Шаблон проекта (0.85.0, docs/entity-types.md §3–4).
 *
 * «Шаблон» здесь — не текст, а УСТРОЙСТВО проекта: типы карточек (с заготовками), карточки-
 * заготовки по выбору и настройки помощника (роль, указания, режим генерации, стиль).
 *
 * Перенос — СЛИЯНИЕ, а не замена: тип с тем же ключом обновляется, остальные добавляются,
 * карточки с занятыми именами пропускаются и попадают в отчёт. Ничего не удаляется: «применил
 * шаблон, и часть настроек исчезла» — это не перенос, а тихая потеря.
 *
 * Тот же JSON едет в архиве проекта файлом template.json — «начни новый проект по образцу
 * старого» делается из уже существующего экспорта.
 */

export interface TemplateType {
  key: string
  title: string
  color?: string
  icon?: string
  card_template?: { description?: string; aliases?: string[] }
}

export interface TemplateCard {
  kind: string
  name: string
  aliases?: string[]
  description?: string
  color?: string
}

export interface TemplateAI {
  role: string
  instructions: string
  enabled: boolean
  generation: string
  image_style: string
}

export interface ProjectTemplate {
  version: number
  entity_types: TemplateType[]
  cards?: TemplateCard[]
  ai?: TemplateAI
}

export interface TemplateSkip {
  name: string
  reason: string
}

/** Отчёт применения: человек должен видеть, что произошло, а не «ок». */
export interface TemplateReport {
  types_added: number
  types_updated: number
  types_skipped?: TemplateSkip[]
  cards_added: number
  cards_skipped?: TemplateSkip[]
  ai_updated: boolean
  /** Сколько всего изменилось: 0 — «всё уже на месте» (идемпотентность, видимая человеку). */
  changed: number
  message: string
}

/** Шаблон проекта файлом. `withCards=false` — без карточек (их переносит архив). */
export async function getProjectTemplate(projectId: string, withCards = true): Promise<ProjectTemplate> {
  const raw = await http
    .get(`projects/${projectId}/template`, {
      searchParams: withCards ? {} : { cards: '0' },
    })
    .json<unknown>()
  return readTemplate(raw)
}

/** Применить шаблон к проекту (только владелец). Возвращает отчёт. */
export async function applyProjectTemplate(
  projectId: string,
  template: ProjectTemplate,
): Promise<TemplateReport> {
  const raw = await http
    .post(`projects/${projectId}/template`, { json: template })
    .json<{ report?: unknown }>()
  const report = readReport(raw?.report)
  if (report === null) throw new Error(tStatic('tpl.errNoReport'))
  return report
}

/** Создать проект «по образцу»: сразу с типами, карточками и настройками помощника. */
export async function createProjectFromTemplate(input: {
  title: string
  description?: string
  template: ProjectTemplate
}): Promise<{ project: { id: string; title: string }; report: TemplateReport }> {
  const raw = await http
    .post('projects/from-template', {
      json: {
        title: input.title,
        description: input.description ?? '',
        template: input.template,
      },
    })
    .json<{ project?: unknown; report?: unknown }>()
  const project = raw?.project as Record<string, unknown> | undefined
  const report = readReport(raw?.report)
  if (!project || typeof project.id !== 'string' || report === null) {
    throw new Error(tStatic('tpl.errNoProject'))
  }
  return {
    project: { id: project.id, title: typeof project.title === 'string' ? project.title : input.title },
    report,
  }
}

/**
 * Шаблон из JSON-файла: человек скачал его из другого проекта или из другой инсталляции.
 *
 * Проверяем форму ДО отправки: «файл не тот» должен читаться как «это не шаблон SkyFraze», а не
 * как 500 от сервера.
 */
export function parseTemplate(text: string): ProjectTemplate {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(tStatic('tpl.errNotJson'))
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(tStatic('tpl.errNoTemplateInFile'))
  }
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.entity_types)) {
    throw new Error(tStatic('tpl.errNoTypes'))
  }
  return readTemplate(raw)
}

/** Имя файла для «скачать шаблон»: как у архива, но с другим расширением. */
export function templateFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'project'}-template.json`
}

function readTemplate(raw: unknown): ProjectTemplate {
  if (typeof raw !== 'object' || raw === null) throw new Error(tStatic('tpl.errUnparsed'))
  const record = raw as Record<string, unknown>
  const rawTypes = Array.isArray(record.entity_types) ? record.entity_types : []
  const rawCards = Array.isArray(record.cards) ? record.cards : []
  // flatMap, а не map+filter: так тип элементов выводится без type predicate, который ломается
  // на необязательных полях интерфейса.
  const entityTypes = rawTypes.flatMap<TemplateType>((item) => {
    if (typeof item !== 'object' || item === null) return []
    const type = item as Record<string, unknown>
    const key = typeof type.key === 'string' ? type.key : ''
    if (!key) return []
    return [
      {
        key,
        title: typeof type.title === 'string' && type.title !== '' ? type.title : key,
        color: typeof type.color === 'string' ? type.color : '',
        icon: typeof type.icon === 'string' ? type.icon : '',
        card_template: readTemplateCardTemplate(type.card_template),
      },
    ]
  })
  const cards = rawCards.flatMap<TemplateCard>((item) => {
    if (typeof item !== 'object' || item === null) return []
    const card = item as Record<string, unknown>
    const name = typeof card.name === 'string' ? card.name : ''
    if (!name) return []
    return [
      {
        kind: typeof card.kind === 'string' ? card.kind : 'character',
        name,
        aliases: Array.isArray(card.aliases)
          ? card.aliases.filter((a): a is string => typeof a === 'string')
          : [],
        description: typeof card.description === 'string' ? card.description : '',
        color: typeof card.color === 'string' ? card.color : '',
      },
    ]
  })
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    entity_types: entityTypes,
    cards,
    ai: readAI(record.ai),
  }
}

function readTemplateCardTemplate(raw: unknown): TemplateType['card_template'] {
  if (typeof raw !== 'object' || raw === null) return { description: '', aliases: [] }
  const record = raw as Record<string, unknown>
  return {
    description: typeof record.description === 'string' ? record.description : '',
    aliases: Array.isArray(record.aliases)
      ? record.aliases.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function readAI(raw: unknown): TemplateAI | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  return {
    role: typeof record.role === 'string' ? record.role : '',
    instructions: typeof record.instructions === 'string' ? record.instructions : '',
    enabled: record.enabled !== false,
    generation: typeof record.generation === 'string' ? record.generation : '',
    image_style: typeof record.image_style === 'string' ? record.image_style : '',
  }
}

function readReport(raw: unknown): TemplateReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const num = (value: unknown) => (typeof value === 'number' ? value : 0)
  const skips = (value: unknown): TemplateSkip[] =>
    Array.isArray(value)
      ? value
          .map((item) => {
            if (typeof item !== 'object' || item === null) return null
            const skip = item as Record<string, unknown>
            return {
              name: typeof skip.name === 'string' ? skip.name : '',
              reason: typeof skip.reason === 'string' ? skip.reason : '',
            }
          })
          .filter((item): item is TemplateSkip => item !== null)
      : []
  return {
    types_added: num(record.types_added),
    types_updated: num(record.types_updated),
    types_skipped: skips(record.types_skipped),
    cards_added: num(record.cards_added),
    cards_skipped: skips(record.cards_skipped),
    ai_updated: record.ai_updated === true,
    changed: num(record.changed),
    message: typeof record.message === 'string' ? record.message : '',
  }
}
