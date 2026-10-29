import type { Project } from '../api/projects'
import { formatBytes } from './format'
import { translate } from '../i18n'
import type { Lang } from '../store/lang'

/**
 * Подпись веса проекта для списка проектов.
 *
 * Зачем: место в проекте раньше было видно только внутри проекта (блок «Файлы
 * проекта»), то есть после открытия. В списке видно сразу — и сразу понятно, у
 * какого проекта место на исходе.
 *
 * Считаем по вложениям (после пережатия): снапшот CRDT пользователю ничего не даёт —
 * его нельзя ни уменьшить, ни удалить, и это техническая деталь, а не содержимое.
 */
export interface ProjectWeight {
  /** «файлы: 8.4 МБ из 10.0 МБ» или «файлы: 300 КБ». */
  text: string
  /** Больше 80% предела — место заканчивается: предупреждаем цветом. */
  tight: boolean
}

export function projectWeight(
  project: Pick<Project, 'asset_bytes' | 'quota_bytes'>,
  lang: Lang = 'ru',
): ProjectWeight | null {
  const used = project.asset_bytes ?? 0
  const limit = project.quota_bytes ?? 0
  // Пустой проект не подписываем: «файлы: 0 Б из 10.0 МБ» на каждой карточке — шум,
  // а предел виден внутри проекта, где его и можно исчерпать.
  if (used <= 0) return null
  if (limit > 0) {
    return {
      text: translate(lang, 'weight.of', { used: formatBytes(used, lang), limit: formatBytes(limit, lang) }),
      tight: used / limit >= 0.8,
    }
  }
  // Предела нет — показываем только вес.
  return { text: translate(lang, 'weight.used', { used: formatBytes(used, lang) }), tight: false }
}
