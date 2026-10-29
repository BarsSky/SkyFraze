import type { Lang } from '../store/lang'
import { localeOf } from './index'

/**
 * Форматирование дат и чисел по языку интерфейса (0.115.0).
 *
 * Почему не «просто `toLocaleString()`»: без явной локали результат зависит от браузера и системы,
 * то есть у двух людей на одном стенде он разный — и это выясняется в отчёте «у меня дата
 * другая». Локаль берём из языка интерфейса, а не из ОС: английский интерфейс должен показывать
 * английские даты.
 *
 * Даты в данных остаются строками `YYYY-MM-DD` (дата кадра, версии): локализуется ПОКАЗ, а не
 * хранение — иначе поедут импорт, экспорт и предложения помощника.
 */
export function formatDate(value: Date | string, lang: Lang, withTime = false): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  const options: Intl.DateTimeFormatOptions = withTime
    ? { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric' }
  return new Intl.DateTimeFormat(localeOf(lang), options).format(date)
}

/** Число с разделителями разрядов по локали интерфейса: 1 234 (ru) / 1,234 (en). */
export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(localeOf(lang)).format(value)
}
