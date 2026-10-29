import { translate, type Key } from '../i18n'
import { pluralForm, type PluralForm } from '../i18n/plural'
import type { Lang } from '../store/lang'

/**
 * Форматирование чисел для ленты, списка проектов и корзины.
 *
 * Вынесено из компонентов: русские склонения — источник ошибок вида «1 просмотров», и их нужно
 * проверять тестом, а не глазами.
 *
 * С 0.116.0 функции принимают язык, но по умолчанию он русский: этим сохранены и вызовы, и
 * прежние тесты (они проверяют русские строки), а английский интерфейс передаёт свой язык явно.
 * Слова берутся из словаря (`views.*`, `days.*`, `bytes.*`), форма — из `pluralForm`.
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

/** Слово из словаря по форме числа: `views.one` / `views.few` / `views.many`. */
function formWord(lang: Lang, prefix: string, n: number): string {
  const form: PluralForm = pluralForm(lang, n)
  return translate(lang, `${prefix}.${form}` as Key)
}

/** «нет просмотров» / «1 просмотр» / «12 просмотров». */
export function formatViews(n: number, lang: Lang = 'ru'): string {
  if (!Number.isFinite(n) || n <= 0) return translate(lang, 'views.none')
  return `${n} ${formWord(lang, 'views', n)}`
}

/** Оценки: «нет оценок» / «5.0 · 1 оценка» / «4.5 · 12 оценок». */
export function formatRating(avg: number, count: number, lang: Lang = 'ru'): string {
  if (!count) return translate(lang, 'rating.none')
  const value = Number.isFinite(avg) ? avg.toFixed(1) : '0.0'
  return `${value} · ${count} ${formWord(lang, 'rating', count)}`
}

/** Дата публикации в коротком виде: 27.09.2026 (формат одинаков в обеих локалях). */
export function formatDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

/**
 * Сколько осталось до окончательного удаления из корзины: «30 дней», «1 день».
 *
 * Склонение считается здесь, а не в компоненте: «вернуть можно ещё 1 дней» — та самая
 * ошибка, которую замечают только те, кто читает интерфейс внимательно. Ноль и мусор
 * дают честное «срок истёк»: проект ещё виден (уборщик пройдёт в ближайшие сутки), но
 * обещать восстановление уже нельзя.
 */
export function formatDaysLeft(days: number, lang: Lang = 'ru'): string {
  if (!Number.isFinite(days) || days <= 0) return translate(lang, 'days.expired')
  return `${days} ${formWord(lang, 'days', days)}`
}

/**
 * Вес файла: «2.0 МБ», «161 КБ», «700 Б».
 *
 * Одна и та же строка нужна в подсказке после загрузки, в списке файлов проекта и
 * в расходе квоты; держать три копии — значит однажды поправить две.
 */
export function formatBytes(bytes: number, lang: Lang = 'ru'): string {
  const unit = (key: Key) => translate(lang, key)
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${unit('bytes.b')}`
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ${unit('bytes.gb')}`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${unit('bytes.mb')}`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} ${unit('bytes.kb')}`
  return `${Math.round(bytes)} ${unit('bytes.b')}`
}
