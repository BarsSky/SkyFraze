import { http } from './client'
import { parseFilename } from './transfer'
import { saveBlob } from '../lib/download'

/**
 * Шаблоны оформления DOCX (0.91.0, docs/docx-template.md).
 *
 * Автор загружает свой .docx (титул, колонтитулы, поля, стили заголовков) с абзацем `{{content}}`,
 * и скачивание проекта собирается в его пакете: текст встаёт на место плейсхолдера, остальное
 * остаётся автора. Шаблонов у проекта может быть несколько — переключаться нужно, чтобы держать,
 * например, «рукопись» и «самиздат».
 */

export interface DocxStyle {
  id: string
  name: string
  type: string
  builtin: boolean
}

export interface DocxPlaceholder {
  found: boolean
  paragraph_style_id?: string
  text?: string
}

export interface DocxPage {
  width?: number
  height?: number
  orientation?: string
  margin_top?: number
  margin_right?: number
  margin_bottom?: number
  margin_left?: number
}

/** Отчёт загрузки: что нашли и что выгрузка сделает со стилями. */
export interface DocxReport {
  has_placeholder: boolean
  has_numbering: boolean
  styles: DocxStyle[]
  /** «title/heading1/quote/…» → идентификатор стиля шаблона. */
  mapping: Record<string, string>
  warnings?: string[]
  page: DocxPage
}

export interface DocxTemplate {
  id: string
  name: string
  filename: string
  size: number
  is_active: boolean
  uploaded_at: string
  styles: DocxStyle[]
  page: DocxPage
  report: DocxReport
  placeholder: DocxPlaceholder
}

export async function listDocxTemplates(projectId: string): Promise<DocxTemplate[]> {
  const raw = await http.get(`projects/${projectId}/docx-templates`).json<{ templates?: unknown }>()
  return readTemplates(raw?.templates)
}

/** Загрузить шаблон. `name` необязателен: без него берётся имя файла без расширения. */
export async function uploadDocxTemplate(
  projectId: string,
  file: File,
  name?: string,
): Promise<DocxTemplate> {
  const form = new FormData()
  form.append('file', file)
  form.append('name', (name ?? '').trim())
  const raw = await http
    .post(`projects/${projectId}/docx-templates`, { body: form, timeout: 120_000 })
    .json<{ template?: unknown }>()
  const template = readTemplate(raw?.template)
  if (template === null) throw new Error('сервер не вернул шаблон')
  return template
}

export async function activateDocxTemplate(projectId: string, id: string): Promise<DocxTemplate[]> {
  const raw = await http
    .post(`projects/${projectId}/docx-templates/${id}/activate`)
    .json<{ templates?: unknown }>()
  return readTemplates(raw?.templates)
}

export async function deleteDocxTemplate(projectId: string, id: string): Promise<DocxTemplate[]> {
  const raw = await http
    .delete(`projects/${projectId}/docx-templates/${id}`)
    .json<{ templates?: unknown }>()
  return readTemplates(raw?.templates)
}

/**
 * Скачать ПРИМЕР шаблона (0.94.0).
 *
 * Зачем файл, а не инструкция: «сделать свой шаблон» начинается с вопроса «а как он выглядит».
 * Пример содержит абзац `{{content}}` отдельной строкой и стили с именами, которые разбор умеет
 * сопоставить (Title, Heading1–4, Quote, Code, Date, ListParagraph) — человеку достаточно открыть
 * его в Word и поменять оформление.
 */
export async function downloadDocxSample(projectId: string): Promise<string> {
  const response = await http.get(`projects/${projectId}/docx-templates/sample`, { timeout: 60_000 })
  const blob = await response.blob()
  const fromHeader = parseFilename(response.headers.get('Content-Disposition'))
  const name = fromHeader || 'skyfraze-template-example.docx'
  saveBlob(blob, name)
  return name
}

/** Подписи карты стилей для интерфейса: «что в проекте». */
export const DOX_MAPPING_LABELS: Record<string, string> = {
  title: 'название проекта',
  heading1: 'главы',
  heading2: 'под-события',
  heading3: 'под-под-события',
  heading4: 'четвёртый уровень',
  body: 'обычный текст',
  quote: 'цитаты',
  code: 'код',
  date: 'даты',
  list: 'списки',
}

export function mappingRows(report: DocxReport): Array<{ key: string; label: string; style: string }> {
  return Object.entries(report.mapping ?? {}).map(([key, style]) => ({
    key,
    label: DOX_MAPPING_LABELS[key] ?? key,
    style,
  }))
}

function readTemplates(raw: unknown): DocxTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap<DocxTemplate>((item) => {
    const template = readTemplate(item)
    return template === null ? [] : [template]
  })
}

function readTemplate(raw: unknown): DocxTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (!id || !name) return null
  const reportRaw = (record.report ?? {}) as Record<string, unknown>
  return {
    id,
    name,
    filename: typeof record.filename === 'string' ? record.filename : '',
    size: typeof record.size === 'number' ? record.size : 0,
    is_active: record.is_active === true,
    uploaded_at: typeof record.uploaded_at === 'string' ? record.uploaded_at : '',
    styles: readStyles(record.styles),
    page: readPage(record.page),
    report: {
      has_placeholder: reportRaw.has_placeholder === true,
      has_numbering: reportRaw.has_numbering === true,
      styles: readStyles(reportRaw.styles),
      mapping: readMapping(reportRaw.mapping),
      warnings: Array.isArray(reportRaw.warnings)
        ? reportRaw.warnings.filter((item): item is string => typeof item === 'string')
        : [],
      page: readPage(reportRaw.page),
    },
    placeholder: readPlaceholder(record.placeholder),
  }
}

function readStyles(raw: unknown): DocxStyle[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap<DocxStyle>((item) => {
    if (typeof item !== 'object' || item === null) return []
    const style = item as Record<string, unknown>
    const id = typeof style.id === 'string' ? style.id : ''
    if (!id) return []
    return [
      {
        id,
        name: typeof style.name === 'string' ? style.name : id,
        type: typeof style.type === 'string' ? style.type : '',
        builtin: style.builtin === true,
      },
    ]
  })
}

function readMapping(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

function readPage(raw: unknown): DocxPage {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const num = (value: unknown) => (typeof value === 'number' ? value : undefined)
  return {
    width: num(record.width),
    height: num(record.height),
    orientation: typeof record.orientation === 'string' ? record.orientation : undefined,
    margin_top: num(record.margin_top),
    margin_right: num(record.margin_right),
    margin_bottom: num(record.margin_bottom),
    margin_left: num(record.margin_left),
  }
}

function readPlaceholder(raw: unknown): DocxPlaceholder {
  if (typeof raw !== 'object' || raw === null) return { found: false }
  const record = raw as Record<string, unknown>
  return {
    found: record.found === true,
    paragraph_style_id:
      typeof record.paragraph_style_id === 'string' ? record.paragraph_style_id : undefined,
    text: typeof record.text === 'string' ? record.text : undefined,
  }
}
