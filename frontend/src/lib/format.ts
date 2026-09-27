/**
 * Форматирование чисел для ленты и публичной страницы.
 *
 * Вынесено из компонентов: русские склонения — источник ошибок вида
 * «1 просмотров», и их нужно проверять тестом, а не глазами.
 */

/** Русское склонение: plural(1,'просмотр','просмотра','просмотров') → 'просмотр'. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n))
  const mod100 = abs % 100
  const mod10 = abs % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/** «нет просмотров» / «1 просмотр» / «12 просмотров». */
export function formatViews(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'нет просмотров'
  return `${n} ${plural(n, 'просмотр', 'просмотра', 'просмотров')}`
}

/** Оценки: «нет оценок» / «5.0 · 1 оценка» / «4.5 · 12 оценок». */
export function formatRating(avg: number, count: number): string {
  if (!count) return 'нет оценок'
  const value = Number.isFinite(avg) ? avg.toFixed(1) : '0.0'
  return `${value} · ${count} ${plural(count, 'оценка', 'оценки', 'оценок')}`
}

/** Дата публикации в коротком виде: 27.09.2026. */
export function formatDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}
