/**
 * Запомненный уровень графа (0.101.0).
 *
 * Зачем: человек, который смотрит мир по группам, возвращается на «Связи» и снова попадает в
 * карточку с наибольшим числом связей — приходится каждый раз заново заходить в группу. Уровень и
 * открытая группа запоминаются на проект; карточка в центре — нет, потому что «какая карточка была
 * открыта неделю назад» полезным состоянием не является.
 *
 * Формат: `level` (`world` | `card`) и `groupKind` (вид карточки или пусто). Читаем защитно: битые
 * данные — «нет запомненного», а не падение страницы.
 */
export type GraphLevel = 'world' | 'card'

export interface GraphView {
  level: GraphLevel
  groupKind: string | null
}

export function graphViewKey(projectId: string): string {
  return `skyfraze-graph-view:${projectId}`
}

/** Минимум от `Storage`, чтобы тест мог подсунуть мок. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readGraphView(projectId: string, storage: StorageLike | null = defaultStorage()): GraphView | null {
  if (!storage || projectId === '') return null
  let raw: string | null = null
  try {
    raw = storage.getItem(graphViewKey(projectId))
  } catch {
    return null
  }
  if (raw === null || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as { level?: unknown; groupKind?: unknown }
    const level = parsed.level === 'world' ? 'world' : parsed.level === 'card' ? 'card' : null
    if (level === null) return null
    const groupKind = typeof parsed.groupKind === 'string' && parsed.groupKind !== '' ? parsed.groupKind : null
    return { level, groupKind }
  } catch {
    // Старая версия схемы или мусор: считаем, что выбора не было.
    return null
  }
}

export function writeGraphView(
  projectId: string,
  view: GraphView,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || projectId === '') return
  try {
    storage.setItem(graphViewKey(projectId), JSON.stringify({ level: view.level, groupKind: view.groupKind ?? '' }))
  } catch {
    // Приватный режим или переполненная квота: запоминание — удобство, а не данные.
  }
}

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage
}
