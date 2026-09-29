import { http } from './client'
import type { Project } from './projects'

/**
 * Перенос проекта между стендами SkyFraze.
 *
 * Экспорт отдаёт ZIP-архив (манифест + дерево событий + CRDT-снапшот + файлы
 * вложений), импорт создаёт из него НОВЫЙ проект у того, кто загрузил архив.
 * Скачали на одном стенде — загрузили на другом: главы, тексты, фон кадров и
 * картинки переносятся целиком.
 */

export interface ImportResult {
  project: Project
  events: number
  assets: number
  state: boolean
}

/** Скачивает архив проекта в браузер. Возвращает имя файла. */
export async function exportProject(projectId: string, projectTitle?: string): Promise<string> {
  const res = await http.get(`projects/${projectId}/export`, {
    // Выгрузка проекта с вложениями может быть тяжёлой — даём время.
    timeout: 300000,
  })
  const blob = await res.blob()
  const fromHeader = parseFilename(res.headers.get('Content-Disposition'))
  const name = fromHeader ?? `${(projectTitle ?? 'project').replace(/[^\w.-]+/g, '-').slice(0, 40)}.skyfraze.zip`

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return name
}

/** Загружает архив на этот стенд; проект создаётся у текущего пользователя. */
export async function importProject(file: File): Promise<ImportResult> {
  const form = new FormData()
  form.append('file', file)
  return await http
    .post('projects/import', { body: form, timeout: 300000 })
    .json<ImportResult>()
}

/** Имя файла из `Content-Disposition`; экспорт md в `storyFiles.ts` зовёт её же. */
export function parseFilename(header: string | null): string | null {
  if (!header) return null
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1])
    } catch {
      return utf8[1]
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : null
}
