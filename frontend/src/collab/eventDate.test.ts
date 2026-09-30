import { describe, expect, it } from 'vitest'
import { dateFromServer, dateLabel, dateToServer } from './eventDate'

/**
 * Дата ходит между CRDT («YYYY-MM-DD» — формат `input[type=date]`) и API
 * (RFC3339: `event_date` — это `*time.Time`). Ошибка в любую сторону тихая:
 * сервер ответит 400 и проекция дерева не применится, поэтому формат закреплён
 * тестом, а не «и так работает».
 */
describe('dateToServer', () => {
  it('дату из поля ввода превращает в RFC3339', () => {
    expect(dateToServer('2026-01-31')).toBe('2026-01-31T00:00:00Z')
    // Фантастические годы — норма для этого проекта: Go принимает год 2789.
    expect(dateToServer('2789-04-12')).toBe('2789-04-12T00:00:00Z')
  })

  it('полное значение из старого снапшота не теряет', () => {
    expect(dateToServer('2026-01-31T12:30:00Z')).toBe('2026-01-31T00:00:00Z')
    expect(dateToServer('2026-01-31 12:30:00')).toBe('2026-01-31T00:00:00Z')
  })

  it('пустое и нестроковое значение — это «даты нет», а не ошибка', () => {
    expect(dateToServer('')).toBeNull()
    expect(dateToServer('   ')).toBeNull()
    expect(dateToServer(null)).toBeNull()
    expect(dateToServer(undefined)).toBeNull()
    expect(dateToServer(20260131)).toBeNull()
  })

  it('непонятный текст не превращается в мусорную дату', () => {
    expect(dateToServer('когда-нибудь')).toBeNull()
    expect(dateToServer('31.01.2026')).toBeNull()
  })
})

describe('dateFromServer', () => {
  it('timestamp из API отдаёт как дату для поля ввода', () => {
    expect(dateFromServer('2026-01-31T00:00:00Z')).toBe('2026-01-31')
    expect(dateFromServer('2026-01-31T23:59:59.999999Z')).toBe('2026-01-31')
  })

  it('пустое значение — пустое поле', () => {
    expect(dateFromServer(null)).toBe('')
    expect(dateFromServer(undefined)).toBe('')
    expect(dateFromServer('')).toBe('')
    expect(dateFromServer('не дата')).toBe('')
  })

  it('круговой обход форматов сохраняет дату', () => {
    for (const day of ['2026-01-01', '2789-04-12', '1999-12-31']) {
      expect(dateFromServer(dateToServer(day))).toBe(day)
    }
  })
})

describe('dateLabel', () => {
  it('показывает дату по-человечески, не разбирая её через Date', () => {
    // Вымышленный год: любой разбор через Date/toLocaleDateString рискует
    // «поправить» его, поэтому форматируем строку как есть.
    expect(dateLabel('2789-04-12')).toBe('12.04.2789')
    expect(dateLabel('2026-01-01T00:00:00Z')).toBe('01.01.2026')
  })

  it('нет даты — нет чипа', () => {
    expect(dateLabel('')).toBeNull()
    expect(dateLabel(null)).toBeNull()
    expect(dateLabel(undefined)).toBeNull()
    expect(dateLabel('скоро')).toBeNull()
  })
})
