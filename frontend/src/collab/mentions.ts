import type { TextField } from './text'

/**
 * Поиск упоминаний карточек мира в тексте (docs/entity-links.md §3.2, фаза 2).
 *
 * Чего здесь намеренно нет: морфологии и лемматизации. Падежи задаются алиасами в карточке
 * («Анна», «Анны», «Анне») — словарь русского языка в этом месте даёт ложные связи и требует
 * поддержки, которой у нас нет.
 *
 * Правила, и каждое из них появилось из конкретной ошибки, которую иначе ловит человек:
 *
 *  1. ОСТАЛЬНОЕ СРАВНЕНИЕ — без учёта регистра: «анна» в середине фразы — это та же Анна.
 *  2. Самый длинный алиас первым: в тексте «Анна Сергеевна» не должна давать ещё и «Анну»
 *     внутри себя. В регулярном выражении это порядок альтернатив (длиннее — раньше).
 *  3. Границы — по буквам, цифрам, подчёркиванию И ДЕФИСУ (`\p{L}\p{N}_-`). Дефис в списке
 *     потому, что «Анна-Мария» — другое имя, и «Анна» внутри него упоминанием не является.
 *     Обычный `\b` здесь не годится: для кириллицы он ведёт себя не так, как ждёт человек.
 *  4. Алиас короче двух знаков не ищется: «Я» или «А» находились бы в каждом предложении.
 *     (Сервер такие алиасы и не принимает — правило есть с двух сторон.)
 *  5. Одно место — одно упоминание: одно регулярное выражение на весь текст даёт
 *     непересекающиеся совпадения по построению, а не по нашей аккуратности.
 *
 * Производительность: одно выражение на текст, а не по одному на алиас. Это важно, потому что
 * упоминания пересчитываются на каждую правку кадра, а в проекте бывает сотня кадров.
 */

/** Минимальная длина алиаса для поиска: короче — шум (см. правило 4). */
export const MIN_ALIAS_LENGTH = 2

/** Карточка в том виде, в каком она нужна поиску. */
import { maskDocxMarkers } from '../lib/docxMarkers'

export interface MentionEntity {
  id: string
  name: string
  aliases: string[]
  /**
   * Вид карточки (0.87.0): нужен всплывающей карточке упоминания — она подписывает карточку
   * так же, как список («Фракция»), а не голым именем. Необязателен: поиск упоминаний работает
   * и без типа.
   */
  kind?: string
}

/** Одно найденное упоминание. `from`/`to` — индексы в UTF-16, как у выделения и якорей. */
export interface Mention {
  entityId: string
  entityName: string
  field: TextField
  from: number
  to: number
  /** Как написано в тексте: «Анны», а не «Анна» — по цитате человек понимает, что нашлось. */
  quote: string
}

/** Кадр для поиска: заголовок и текст. */
export interface MentionFrame {
  id: string
  title: string
  body: string
}

/**
 * Поиск всех упоминаний в одном тексте.
 *
 * Возвращает совпадения в порядке появления: так их удобно и показывать, и сопоставлять с
 * текстом.
 */
export function findMentions(
  text: string,
  entities: MentionEntity[],
  field: TextField = 'body',
): Mention[] {
  const pattern = buildPattern(entities)
  if (pattern === null || text === '') return []
  const byAlias = aliasIndex(entities)
  const out: Mention[] = []
  // Маркеры DOCX (0.92.0) не участвуют в поиске упоминаний, но и не сдвигают позиции: маска
  // сохраняет длину, поэтому `from`/`to` остаются валидными для СЫРОГО текста (на них держатся
  // подсветка и якоря замечаний).
  const searchable = maskDocxMarkers(text)
  const re = new RegExp(pattern.source, 'giu')
  for (const match of searchable.matchAll(re)) {
    const quote = match[0]
    const entity = byAlias.get(quote.toLowerCase())
    if (!entity) continue
    const from = match.index ?? 0
    out.push({
      entityId: entity.id,
      entityName: entity.name,
      field,
      from,
      to: from + quote.length,
      quote,
    })
  }
  return out
}

/** Упоминания кадра: заголовок и текст вместе (заголовок идёт первым, у него свой field). */
export function frameMentions(frame: MentionFrame, entities: MentionEntity[]): Mention[] {
  return [
    ...findMentions(frame.title, entities, 'title'),
    ...findMentions(frame.body, entities, 'body'),
  ]
}

/**
 * Упоминания одной карточки в кадре (0.92.1).
 *
 * Зачем группировать. Раньше список показывал КАЖДОЕ вхождение: в кадре, где Ганимед назван
 * шесть раз, появлялось шесть чипов «Ганимед» подряд — список распухал, и найти в нём нужную
 * карточку становилось труднее, чем имя в тексте (отчёт: «упоминания дублируются слишком много
 * раз»). Карточка — это сущность, а не место в тексте, поэтому чип один, а число вхождений
 * показывается счётчиком.
 */
export interface MentionGroup {
  entityId: string
  entityName: string
  /** Вхождения в порядке текста: сначала заголовок, потом тело. */
  mentions: Mention[]
}

/**
 * Сгруппировать упоминания по карточкам, сохранив порядок первого появления.
 *
 * Порядок важен: список читается как «кто здесь назван и в каком порядке», и пересортировка по
 * алфавиту или по частоте ломала бы это соответствие тексту.
 */
export function groupMentions(mentions: Mention[]): MentionGroup[] {
  const byId = new Map<string, MentionGroup>()
  const out: MentionGroup[] = []
  for (const mention of mentions) {
    const existing = byId.get(mention.entityId)
    if (existing) {
      existing.mentions.push(mention)
      continue
    }
    const group: MentionGroup = {
      entityId: mention.entityId,
      entityName: mention.entityName,
      mentions: [mention],
    }
    byId.set(mention.entityId, group)
    out.push(group)
  }
  return out
}

/** Сколько РАЗНЫХ кадров содержит каждую карточку и сколько всего упоминаний. */
export interface EntityUsage {
  frames: number
  mentions: number
}

export function entityUsage(
  frames: MentionFrame[],
  entities: MentionEntity[],
): Record<string, EntityUsage> {
  const usage: Record<string, EntityUsage> = {}
  for (const entity of entities) usage[entity.id] = { frames: 0, mentions: 0 }
  for (const frame of frames) {
    const seen = new Set<string>()
    for (const mention of frameMentions(frame, entities)) {
      const row = usage[mention.entityId]
      if (!row) continue
      row.mentions += 1
      seen.add(mention.entityId)
    }
    for (const id of seen) usage[id].frames += 1
  }
  return usage
}

/** Кадр в хронологии сущности: где она появляется и каким словом названа. */
export interface FrameWithMentions {
  frameId: string
  title: string
  /** Номер кадра в дереве («01.2») — по нему человек находит его в списке. */
  number: string
  /** Дата кадра «ГГГГ-ММ-ДД» или пусто. */
  date: string
  /** Порядок в дереве: он же порядок для кадров без даты. */
  order: number
  mentions: Mention[]
}

/** Кадр с метаданными, нужными хронологии. */
export interface DatedFrame extends MentionFrame {
  number?: string
  date?: string
  order?: number
}

/**
 * Кадры по карточкам, в хронологическом порядке.
 *
 * Порядок — решение, а не деталь: **сначала кадры с датой, по возрастанию даты, затем кадры
 * без даты в порядке дерева**. Смешивать их одним компаратором нельзя: у кадра без даты нет
 * «места» на шкале, и любой выбор («в конце», «по структуре») приходится называть вслух.
 * Выбрано так потому, что человек, спрашивающий «где появляется Анна», думает датами, а
 * кадры без даты — это то, что ещё не расставлено по времени.
 */
export function framesByEntity(
  frames: DatedFrame[],
  entities: MentionEntity[],
): Record<string, FrameWithMentions[]> {
  const out: Record<string, FrameWithMentions[]> = {}
  for (const entity of entities) out[entity.id] = []
  frames.forEach((frame, index) => {
    const found = frameMentions(frame, entities)
    if (found.length === 0) return
    const byEntity = new Map<string, Mention[]>()
    for (const mention of found) {
      const list = byEntity.get(mention.entityId) ?? []
      list.push(mention)
      byEntity.set(mention.entityId, list)
    }
    for (const [entityId, mentions] of byEntity) {
      const row = out[entityId]
      if (!row) continue
      row.push({
        frameId: frame.id,
        title: frame.title,
        number: frame.number ?? '',
        date: frame.date ?? '',
        order: frame.order ?? index,
        mentions,
      })
    }
  })
  for (const id of Object.keys(out)) out[id] = orderChronologically(out[id])
  return out
}

/**
 * Хронология: с датой — по дате, без даты — в порядке дерева, следом.
 *
 * `YYYY-MM-DD` сравнивается как строка: это ровно тот случай, когда лексикографический порядок
 * совпадает с календарным, и приводить дату к `Date` ради сравнения не нужно.
 */
export function orderChronologically(list: FrameWithMentions[]): FrameWithMentions[] {
  const dated = list.filter((frame) => frame.date !== '')
  const undated = list.filter((frame) => frame.date === '')
  dated.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1))
  undated.sort((a, b) => a.order - b.order)
  return [...dated, ...undated]
}

/** Глава для матрицы: столбец «персонажи × главы». */
export interface MatrixChapter {
  id: string
  title: string
  number: string
}

/**
 * Кадр внутри клетки матрицы (0.87.0): где именно в этой главе встречается карточка.
 *
 * Зачем: клетка отвечала «сколько», а всплывающая карточка должна ответить «где» — списком
 * кадров этой главы, чтобы человек выбрал нужный и перешёл в него.
 */
export interface MatrixFrameMention {
  id: string
  title: string
  /** Сколько раз карточка упомянута в этом кадре. */
  mentions: number
  /** Первое упоминание кадра: по нему подсвечивается слово при переходе. */
  mention: Mention
}

/** Клетка матрицы: сколько упоминаний и куда вести по клику (0.73.0). */
export interface MatrixCell {
  count: number
  /** Первое упоминание в этой главе: по нему открывается кадр и выделяется слово. */
  first?: { frameId: string; mention: Mention }
  /** Кадры главы с этой карточкой, в порядке дерева (0.87.0). */
  frames?: MatrixFrameMention[]
}

/** Строка матрицы: карточка и её упоминания по главам (в порядке столбцов). */
export interface MatrixRow {
  entity: MentionEntity
  /** Клетки по главам; `count = 0` — не встречается. */
  cells: MatrixCell[]
  total: number
}

/** Матрица связей «персонажи × главы». */
export interface MentionMatrix {
  chapters: MatrixChapter[]
  rows: MatrixRow[]
}

/** Глава, к которой относится кадр: нужен родитель кадра и цепочка до корня. */
export interface FrameChapter {
  frameId: string
  chapterId: string
}

/**
 * Матрица «персонажи × главы» — ответ на «кто с кем в одной главе».
 *
 * Зачем отдельным видом, если есть хронология: хронология отвечает «когда», а матрица — «кто
 * рядом». Это единственный экран, где видно, что два персонажа ни разу не встречаются в одной
 * главе, хотя оба «главные».
 *
 * Кадры без главы (потерянный родитель, корневой под-кадр) в матрицу не попадают: столбца для
 * них нет, а придумывать «бесхозную» колонку значило бы показывать структуру, которой нет.
 */
export function mentionMatrix(
  frames: DatedFrame[],
  frameChapters: FrameChapter[],
  chapters: MatrixChapter[],
  entities: MentionEntity[],
): MentionMatrix {
  const chapterByFrame = new Map(frameChapters.map((row) => [row.frameId, row.chapterId]))
  // Для каждой (глава, карточка) храним счётчик и ПЕРВОЕ упоминание: по нему клетка становится
  // ссылкой в кадр. Без этого матрица отвечала «сколько», но не давала перейти туда, где это
  // видно, — а именно перехода не хватало в отчёте.
  const cells = new Map<string, Map<string, MatrixCell>>()

  for (const frame of frames) {
    const mentions = frameMentions(frame, entities)
    if (mentions.length === 0) continue
    const chapterId = chapterByFrame.get(frame.id)
    if (!chapterId) continue
    const perEntity = cells.get(chapterId) ?? new Map<string, MatrixCell>()
    for (const mention of mentions) {
      const cell = perEntity.get(mention.entityId)
      if (!cell) {
        perEntity.set(mention.entityId, {
          count: 1,
          first: { frameId: frame.id, mention },
          // Кадры клетки собираем сразу: всплывающая карточка показывает «где встречается»,
          // и второй проход по всем кадрам ради этого не нужен.
          frames: [{ id: frame.id, title: frame.title, mentions: 1, mention }],
        })
        continue
      }
      cell.count += 1
      const inFrame = cell.frames?.find((item) => item.id === frame.id)
      if (inFrame) {
        inFrame.mentions += 1
      } else {
        cell.frames?.push({ id: frame.id, title: frame.title, mentions: 1, mention })
      }
    }
    cells.set(chapterId, perEntity)
  }

  // Столбцы — только главы, где что-то нашлось, в порядке дерева: пустые столбцы делают
  // таблицу шире экрана и не сообщают ничего.
  const used = chapters.filter((chapter) => cells.has(chapter.id))
  const rows: MatrixRow[] = entities.map((entity) => {
    const row = used.map(
      (chapter) => cells.get(chapter.id)?.get(entity.id) ?? { count: 0 },
    )
    const total = row.reduce((sum, cell) => sum + cell.count, 0)
    return { entity, cells: row, total }
  })
  // Строки — по числу упоминаний: «сироты» и редкие внизу, главные сверху.
  rows.sort((a, b) => b.total - a.total)
  return { chapters: used, rows }
}

/**
 * Собирает одно регулярное выражение из всех алиасов.
 *
 * `null`, когда искать нечего: пустой паттерн совпал бы с пустой строкой на каждом месте.
 */
function buildPattern(entities: MentionEntity[]): RegExp | null {
  const aliases = collectAliases(entities)
  if (aliases.length === 0) return null
  // Длиннее — раньше: так «Анна Сергеевна» выигрывает у «Анна» на одном и том же месте.
  const alternatives = aliases.map((alias) => escapeRegExp(alias))
  const boundary = '[\\p{L}\\p{N}_-]'
  return new RegExp(`(?<!${boundary})(?:${alternatives.join('|')})(?!${boundary})`, 'iu')
}

/** Все алиасы карточек: имя плюс алиасы, без дублей и без слишком коротких. */
function collectAliases(entities: MentionEntity[]): string[] {
  const seen = new Map<string, string>()
  for (const entity of entities) {
    for (const raw of [entity.name, ...entity.aliases]) {
      const alias = raw.trim()
      if ([...alias].length < MIN_ALIAS_LENGTH) continue
      const key = alias.toLowerCase()
      if (!seen.has(key)) seen.set(key, alias)
    }
  }
  return [...seen.values()].sort((a, b) => b.length - a.length)
}

/** Алиас (в нижнем регистре) → карточка: по совпадению восстанавливаем, кто это. */
function aliasIndex(entities: MentionEntity[]): Map<string, MentionEntity> {
  const index = new Map<string, MentionEntity>()
  for (const entity of entities) {
    for (const raw of [entity.name, ...entity.aliases]) {
      const alias = raw.trim()
      if ([...alias].length < MIN_ALIAS_LENGTH) continue
      const key = alias.toLowerCase()
      if (!index.has(key)) index.set(key, entity)
    }
  }
  return index
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
