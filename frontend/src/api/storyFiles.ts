import { http } from './client'
import { parseFilename } from './transfer'

/**
 * Выгрузка проекта в Markdown и обратная загрузка папки с md-файлами.
 *
 * Формат описан в `docs/import-export.md`: проект отдаётся либо одной лентой
 * (`export.md`), либо zip-архивом, где рядом с текстом лежат главы по файлам и
 * картинки (`export.md?assets=1`). Обратно принимается папка с md (имена частей —
 * относительные пути, как их отдаёт браузер для каталога) или тот же zip.
 *
 * Импорт двухшаговый: `preview` разбирает файлы и НИЧЕГО не пишет — человек
 * сначала видит дерево, знаки и предупреждения; проект создаётся только вторым
 * вызовом. Фатальная ошибка на любом шаге означает, что проекта не появилось.
 */

export interface MarkdownImportEvent {
  /** Номер кадра как он будет в проекте: `01`, `01.1`, `01.1.1`. */
  number: string
  /** Глубина вложенности: 0 — глава, 1 — под-событие. */
  depth: number
  title: string
  /** Относительный путь файла внутри папки — по нему объясняем предупреждения. */
  path: string
  /** Сколько знаков в теле события: пустой файл видно до создания проекта. */
  chars: number
  /** Замечания именно к этому событию (пустой файл, дубль номера). */
  warnings: string[]
}

export interface MarkdownImportStats {
  files: number
  events: number
  chars: number
  /** Ссылок на картинки в текстах — их мы пытаемся превратить во вложения. */
  imageLinks: number
  /** Сколько файлов набора станут вложениями проекта (картинки, pdf и прочее). */
  attachments: number
  /** Ссылки, для которых файла в наборе не нашлось: останутся текстом как есть. */
  missingFiles: number
  /** Файлы набора, на которые никто не ссылается: в проект они не попадут. */
  unusedFiles: number
}

export interface MarkdownImportPreview {
  projectTitle: string
  events: MarkdownImportEvent[]
  warnings: string[]
  stats: MarkdownImportStats
}

export interface MarkdownImportResult {
  projectId: string
  events: number
  warnings: string[]
}

/**
 * Что загружаем: папку с md-файлами или один zip.
 *
 * Папку отдаём массивом (имя части — относительный путь), zip — отдельным полем
 * `archive`: смешивать их в одном запросе нельзя, сервер не поймёт, какое дерево
 * считать главным.
 */
export type MarkdownImportSource = File[] | { archive: File }

export interface ExportMarkdownOptions {
  /** `true` — zip: story.md + главы по файлам + assets/. */
  assets: boolean
  /** Заголовок проекта — для имени файла, если сервер не прислал Content-Disposition. */
  projectTitle?: string
}

/** Скачивает выгрузку в браузер и возвращает имя файла — его показываем в плашке. */
export async function exportStoryMarkdown(
  projectId: string,
  options: ExportMarkdownOptions,
): Promise<string> {
  const res = await http.get(`projects/${encodeURIComponent(projectId)}/export.md`, {
    searchParams: options.assets ? { assets: '1' } : undefined,
    // Выгрузка с картинками может быть тяжёлой — даём время, как у архива переноса.
    timeout: 300000,
  })
  const blob = await res.blob()
  const name = markdownExportFilename(
    res.headers.get('Content-Disposition'),
    options.projectTitle,
    options.assets,
  )
  saveBlob(blob, name)
  return name
}

/** Предпросмотр: сервер разбирает файлы и ничего не записывает. */
export async function previewMarkdownImport(
  source: MarkdownImportSource | null | undefined,
): Promise<MarkdownImportPreview> {
  const form = requireMarkdownForm(source)
  const raw = await http
    .post('projects/import/markdown/preview', { body: form, timeout: 300000 })
    .json<unknown>()
  return parseMarkdownPreview(raw)
}

/** Создаёт НОВЫЙ проект из тех же файлов; при фатальной ошибке проекта не появляется. */
export async function importMarkdownFolder(
  source: MarkdownImportSource | null | undefined,
  title?: string,
): Promise<MarkdownImportResult> {
  const form = requireMarkdownForm(source)
  const clean = title?.trim()
  // Пустое поле = «название возьми из файлов»: сервер сам решит по правилам разбора.
  if (clean) form.append('title', clean)
  const raw = await http
    .post('projects/import/markdown', { body: form, timeout: 300000 })
    .json<unknown>()
  return parseMarkdownImportResult(raw)
}

/**
 * Место вставки куска в существующий проект.
 *
 * `parentId` — под какое событие положить корень куска (нет — верхний уровень);
 * `beforeId`/`afterId` — перед каким или после какого события он встанет.
 * «Перед» и «после» одновременно сервер отвергает: это два разных места.
 */
export interface MarkdownInsertPlace {
  parentId?: string | null
  beforeId?: string | null
  afterId?: string | null
}

/**
 * Вставляет разобранный кусок в СУЩЕСТВУЮЩИЙ проект (импорт «в место»).
 *
 * Проект не создаётся: кусок встаёт в его CRDT-документ, а таблица событий
 * перестраивается из документа. Если в проекте открыта живая комната, вставку
 * получают все подключённые редакторы сразу; вкладка без realtime перечитывает
 * состояние (`reloadFromServer`) — см. ProjectTimelinePage.
 */
export async function importMarkdownInto(
  projectId: string,
  source: MarkdownImportSource | null | undefined,
  place: MarkdownInsertPlace,
): Promise<MarkdownImportResult> {
  const form = requireMarkdownForm(source)
  if (place.parentId) form.append('parent_id', place.parentId)
  if (place.beforeId) form.append('before_id', place.beforeId)
  else if (place.afterId) form.append('after_id', place.afterId)
  const raw = await http
    .post(`projects/${encodeURIComponent(projectId)}/import/markdown`, { body: form, timeout: 300000 })
    .json<unknown>()
  return parseMarkdownImportResult(raw)
}

/**
 * Собирает multipart для импорта.
 *
 * Имя части для файла папки — `webkitRelativePath` БЕЗ первого сегмента
 * (`Моя история/02-Мир/01-Города.md` → `02-Мир/01-Города.md`): сервер трактует
 * «каталог = уровень вложенности» буквально, и каждый каталог становится
 * событием. Корень выбранной папки — это сам проект, поэтому без среза он
 * превратился бы в лишнюю главу-обёртку. Файл прямо в корне отдаём обычным
 * именем.
 *
 * Zip уходит отдельным полем `archive` — там корень снимает сервер. Пустой
 * выбор — это `null`, а не пустая форма: так «ничего не выбрано» не превращается
 * в запрос к серверу.
 */
export function buildMarkdownImportForm(
  source: MarkdownImportSource | null | undefined,
): FormData | null {
  if (!source) return null
  const form = new FormData()
  if (Array.isArray(source)) {
    if (source.length === 0) return null
    for (const file of source) {
      form.append('files', file, markdownPartName(file))
    }
    return form
  }
  if (!(source.archive instanceof File)) return null
  form.append('archive', source.archive)
  return form
}

/** Имя части файла папки: относительный путь без корневого каталога. */
function markdownPartName(file: File): string {
  const relative = file.webkitRelativePath
  if (!relative) return file.name
  const cut = relative.indexOf('/')
  if (cut < 0) return relative
  // После среза пути не осталось (файл прямо в корне) — берём обычное имя.
  return relative.slice(cut + 1) || file.name
}

/** Разбор предпросмотра: ответ приходит с сервера, поэтому проверяем каждое поле. */
export function parseMarkdownPreview(raw: unknown): MarkdownImportPreview {
  const source = asRecord(raw)
  const events = Array.isArray(source?.events)
    ? source.events.map(parseEvent).filter((event): event is MarkdownImportEvent => event !== null)
    : []
  return {
    projectTitle: asText(source?.project_title),
    events,
    warnings: asStrings(source?.warnings),
    stats: parseStats(source?.stats, events),
  }
}

/** Разбор ответа создания проекта: страница идёт на `project_id`. */
export function parseMarkdownImportResult(raw: unknown): MarkdownImportResult {
  const source = asRecord(raw)
  return {
    projectId: asText(source?.project_id),
    events: asCount(source?.events),
    warnings: asStrings(source?.warnings),
  }
}

/**
 * Текст ошибки с сервера: на фатальном отказе импорта именно он объясняет причину
 * («больше 2000 файлов», «это не zip»). Нет тела — пусть плашка расскажет сама.
 */
export async function readImportErrorMessage(error: unknown): Promise<string | null> {
  const response = (error as { response?: Response } | null)?.response
  if (!response) return null
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const message = asRecord(body)?.error
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null
}

/** Имя файла выгрузки: заголовок сервера главнее, иначе — слаг от названия проекта. */
export function markdownExportFilename(
  header: string | null,
  projectTitle: string | undefined,
  assets: boolean,
): string {
  const fromHeader = parseFilename(header)
  if (fromHeader) return fromHeader
  const base = slugifyFilename(projectTitle ?? 'project')
  // Без картинок — один `проект.md`; с картинками — `проект.md.zip` (внутри story.md и assets/).
  return assets ? `${base}.md.zip` : `${base}.md`
}

/**
 * Слаг для имени файла. Кириллица остаётся: имя скачанного файла читает человек,
 * а не только машина (у сервера тот же подход — `SlugifyFileName`).
 */
function slugifyFilename(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug || 'project'
}

/** Скачивание, как у архива переноса: blob → временная ссылка → клик по <a>. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function requireMarkdownForm(source: MarkdownImportSource | null | undefined): FormData {
  const form = buildMarkdownImportForm(source)
  if (!form) throw new Error('Не выбрано ни одного файла — выберите папку с md или zip')
  return form
}

function parseEvent(raw: unknown): MarkdownImportEvent | null {
  const item = asRecord(raw)
  if (!item) return null
  const number = asText(item.number)
  const title = asText(item.title)
  const path = asText(item.path)
  // Строка без номера, заголовка и пути — не событие: в дереве ей нечего показывать.
  if (number === '' && title === '' && path === '') return null
  return {
    number,
    depth: Math.min(9, asWhole(item.depth)),
    title,
    path,
    chars: asWhole(item.chars),
    warnings: asStrings(item.warnings),
  }
}

function parseStats(raw: unknown, events: MarkdownImportEvent[]): MarkdownImportStats {
  const item = asRecord(raw)
  return {
    files: asCount(item?.files),
    // Сервер не прислал статистику — считаем по разобранному дереву: счётчик не
    // должен показывать ноль рядом с непустым списком событий.
    events: asCount(item?.events) || events.length,
    chars: asCount(item?.chars) || events.reduce((sum, event) => sum + event.chars, 0),
    imageLinks: asCount(item?.image_links),
    attachments: asCount(item?.attachments),
    missingFiles: asCount(item?.missing_files),
    unusedFiles: asCount(item?.unused_files),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** Неотрицательное целое: отрицательные и дробные значения сервера не показываем как есть. */
function asWhole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/** Счётчик: у нечисловых значений остаётся ноль. */
function asCount(value: unknown): number {
  return asWhole(value)
}
