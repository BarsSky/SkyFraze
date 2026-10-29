import { describe, expect, it } from 'vitest'
import { translate, type Key } from './index'
import { pluralForm } from './plural'
import { formatDate, formatNumber } from './format'

/**
 * Каркас локализации (0.115.0).
 *
 * Проверяется то, что нельзя увидеть глазами на одном языке: подстановка параметров, запасной
 * вариант при отсутствующем ключе, русские формы множественного числа и форматирование по локали.
 * Ошибка здесь не ломает страницу, а тихо показывает «5 кадра» или дату в чужом формате.
 */
describe('i18n: словари и подстановка', () => {
  it('переводит известный ключ на оба языка', () => {
    expect(translate('ru', 'nav.projects')).toBe('Мои проекты')
    expect(translate('en', 'nav.projects')).toBe('My projects')
  })

  it('подставляет параметры {version}', () => {
    expect(translate('ru', 'about.build.value', { version: 'v1.2.3' })).toBe('Сборка v1.2.3')
    expect(translate('en', 'about.build.value', { version: 'v1.2.3' })).toBe('Build v1.2.3')
  })

  it('не съедает незнакомый плейсхолдер и не падает без параметров', () => {
    // В шаблоне есть `{version}`, параметра нет — оставляем как есть, чтобы дефект был виден.
    expect(translate('ru', 'about.build.value')).toBe('Сборка {version}')
  })

  it('на неизвестный ключ возвращает сам ключ, а не пустую строку', () => {
    // Пустая подпись выглядит как «кнопка без текста»; имя ключа сразу показывает, где искать.
    expect(translate('ru', 'no.such.key' as Key)).toBe('no.such.key')
  })

  it('в английском словаре столько же ключей, сколько в русском', () => {
    // Тип `Record<Key, string>` ловит это на этапе tsc, но тест страхует от `as unknown as`.
    expect(translate('en', 'about.foot')).toBe(translate('ru', 'about.foot'))
    expect(translate('en', 'about.foot')).toContain('Apache-2.0')
  })
})

describe('i18n: множественное число', () => {
  it('русские формы: 1 кадр, 2 кадра, 5 кадров, 11 кадров, 21 кадр', () => {
    expect(pluralForm('ru', 1)).toBe('one')
    expect(pluralForm('ru', 2)).toBe('few')
    expect(pluralForm('ru', 4)).toBe('few')
    expect(pluralForm('ru', 5)).toBe('many')
    expect(pluralForm('ru', 11)).toBe('many')
    expect(pluralForm('ru', 12)).toBe('many')
    expect(pluralForm('ru', 21)).toBe('one')
    expect(pluralForm('ru', 22)).toBe('few')
    expect(pluralForm('ru', 111)).toBe('many')
    expect(pluralForm('ru', 0)).toBe('many')
  })

  it('английскому хватает двух форм', () => {
    expect(pluralForm('en', 1)).toBe('one')
    expect(pluralForm('en', 0)).toBe('many')
    expect(pluralForm('en', 2)).toBe('many')
  })
})

describe('i18n: форматирование', () => {
  it('дата форматируется по локали интерфейса', () => {
    const date = new Date('2026-03-05T12:00:00Z')
    expect(formatDate(date, 'ru')).toContain('марта')
    expect(formatDate(date, 'en')).toContain('March')
  })

  it('число получает разделители разрядов по локали', () => {
    expect(formatNumber(1234, 'ru').replace(/\s/g, ' ')).toBe('1 234')
    expect(formatNumber(1234, 'en')).toBe('1,234')
  })

  it('на мусорной дате возвращает исходную строку, а не «Invalid Date»', () => {
    expect(formatDate('не дата', 'ru')).toBe('не дата')
  })
})
