/**
 * Дата события живёт в двух форматах, и это разные требования двух сторон.
 *
 * В CRDT и в интерфейсе — «YYYY-MM-DD»: ровно это принимает и отдаёт
 * `input[type=date]` (`EventEditor.tsx`). Серверу же в проекции дерева нужен
 * RFC3339: `event_date` в API — это `*time.Time`, и строка «2026-01-01» не
 * разбирается вовсе (запрос падает с 400 «invalid json»).
 *
 * Обратное направление — засев CRDT из таблицы `events`: сервер отдаёт полный
 * timestamp (`2026-01-01T00:00:00Z`), а полю даты нужны первые 10 символов.
 *
 * Раньше этой связи не было вовсе: проекция дерева дату не несла (`yFlatTree`
 * её не заполнял), поэтому выставленная в редакторе дата оставалась только в
 * CRDT, а в базе — нет. Заодно дата импортированного проекта не доезжала до
 * первого редактора: засев берёт только id/parent_id/title/body.
 */

/** Значение из CRDT → то, что понимает сервер (RFC3339), либо `null`. */
export function dateToServer(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null

  // Основной формат: то, что пишет `input[type=date]`.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00Z`

  // Совместимость: в CRDT могло попасть полное значение — из импорта проекта
  // или из более ранних версий. Берём из него дату, а не отклоняем всё поле.
  const embedded = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(text)
  if (embedded) return `${embedded[1]}T00:00:00Z`

  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Значение из API/БД → «YYYY-MM-DD» для поля даты (или пустая строка). */
export function dateFromServer(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''

  const embedded = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  if (embedded) return embedded[1]

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

/**
 * Дата для показа в кадре: «17.05.2024».
 *
 * Форматируем строку, а не `Date`: годы в этих историях вымышленные (2789), и
 * любой разбор через `Date`/`toLocaleDateString` рискует их «поправить».
 * Пустое или непонятное значение — `null`, то есть чипа просто нет.
 */
export function dateLabel(value: unknown): string | null {
  const iso = dateFromServer(value)
  if (!iso) return null
  const [year, month, day] = iso.split('-')
  return `${day}.${month}.${year}`
}
