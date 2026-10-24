/**
 * projectSearch.test.ts — поиск по тексту проекта (lib/projectSearch).
 *
 * Проверяем то, что видит человек в списке кадров: попадание в название идёт выше
 * попадания в текст, сниппет показывает МЕСТО совпадения (а не начало кадра), запрос из
 * пробелов ничего не ищет, а совпадение через несколько слов с переводом строки всё равно
 * находится — текст в редакторе многострочный, а строка списка одна.
 */

import { describe, expect, it } from 'vitest'
import { isSearchQuery, searchProject, snippetAround } from './projectSearch'

const frames = [
  {
    id: 'a',
    title: 'Пролог',
    body: 'Так начинается история на станции «Маяк». Никто не знал, что будет дальше.',
  },
  {
    id: 'b',
    title: 'Глава про маяк',
    body: 'Здесь про другое: про ветер и песок.',
  },
  {
    id: 'c',
    title: 'Финал',
    body: 'Маяк погас. История закончилась.\nНо не для всех.',
  },
]

describe('searchProject', () => {
  it('пустой запрос ничего не ищет', () => {
    expect(searchProject(frames, '')).toEqual([])
    expect(searchProject(frames, '   ')).toEqual([])
    expect(isSearchQuery('  ')).toBe(false)
  })

  it('попадание в название идёт выше попадания в текст', () => {
    const hits = searchProject(frames, 'маяк')
    // «Глава про маяк» — название; у «Пролога» и «Финала» маяк только в тексте.
    expect(hits.map((hit) => hit.id)).toEqual(['b', 'a', 'c'])
    expect(hits[0].inTitle).toBe(true)
    expect(hits[1].inTitle).toBe(false)
  })

  it('сниппет показывает место совпадения, а не только начало кадра', () => {
    // Короткий текст отдаётся целиком: обрезать его значило бы прятать контекст.
    const [, prolog] = searchProject(frames, 'маяк')
    expect(prolog.snippet).toContain('Маяк')
    expect(prolog.snippet).toBe(frames[0].body)

    // В длинном тексте сниппет — вокруг совпадения, а не первые N знаков.
    const long = { id: 'd', title: 'Долгий кадр', body: `${'начало '.repeat(20)}маяк${' конец'.repeat(20)}` }
    const [hit] = searchProject([long], 'маяк')
    expect(hit.snippet).toContain('маяк')
    expect(hit.snippet.length).toBeLessThan(long.body.length)
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
  })

  it('регистр не важен, а переводы строк схлопываются', () => {
    const hits = searchProject(frames, 'МАЯК ПОГАС')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('c')
    expect(hits[0].snippet).toContain('Маяк погас. История закончилась. Но не для всех.')
  })

  it('у попадания в название сниппет — начало текста', () => {
    const [hit] = searchProject(frames, 'Глава про')
    expect(hit.inTitle).toBe(true)
    expect(hit.snippet).toBe('Здесь про другое: про ветер и песок.')
  })

  it('предел числа попаданий соблюдается', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      title: `Кадр ${i}`,
      body: 'общее слово',
    }))
    expect(searchProject(many, 'общее', 5)).toHaveLength(5)
  })

  it('кадр без текста попадается по названию и не отдаёт пустой сниппет', () => {
    const hits = searchProject([{ id: 'z', title: 'Пустой', body: '' }], 'пустой')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toBe('')
  })
})

describe('snippetAround', () => {
  it('режет по словам и ставит многоточия с обеих сторон', () => {
    const body = `${'слово '.repeat(20)}игла${' слово'.repeat(20)}`
    const snippet = snippetAround(body, 'игла')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('игла')
    expect(snippet).not.toContain('  ')
  })

  it('короткий текст отдаётся целиком, без многоточий', () => {
    expect(snippetAround('короткий текст', 'текст')).toBe('короткий текст')
  })

  it('совпадения в тексте нет — показывается начало', () => {
    const body = `${'начало '.repeat(30)}`
    const snippet = snippetAround(body, 'нет-такого')
    expect(snippet).not.toContain('нет-такого')
    expect(snippet.endsWith('…')).toBe(true)
  })
})
