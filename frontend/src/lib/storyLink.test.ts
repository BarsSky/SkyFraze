import { describe, expect, it } from 'vitest'
import { buildStoryQuoteUrl, readStoryQuoteTarget } from './storyLink'

/**
 * Ссылка на фразу в публичной истории (0.136.0).
 *
 * Проверяем ровно то, от чего зависит обещание «открылась эта строка»: адрес несёт кадр и фразу,
 * переживает кодирование (пробелы, кавычки, «ё») и разбирается обратно. И то, что ссылка без кадра
 * считается обычной страницей, а не «какой-то кадр».
 */
describe('buildStoryQuoteUrl', () => {
  it('собирает адрес с кадром и фразой', () => {
    const url = buildStoryQuoteUrl('https://fraze.example', 'prolog', {
      frameId: 'f1',
      quote: 'Аня стоит на пороге',
    })
    expect(url.startsWith('https://fraze.example/s/prolog?')).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('frame')).toBe('f1')
    expect(params.get('q')).toBe('Аня стоит на пороге')
  })

  it('без фразы оставляет только кадр', () => {
    const url = buildStoryQuoteUrl('https://fraze.example', 'prolog', { frameId: 'f1', quote: '   ' })
    const params = new URL(url).searchParams
    expect(params.get('frame')).toBe('f1')
    expect(params.get('q')).toBeNull()
  })

  it('не удваивает слэш в начале и кодирует slug и кавычки', () => {
    const url = buildStoryQuoteUrl('https://fraze.example/', 'моя история', {
      frameId: 'f1',
      quote: 'он сказал «да»',
    })
    expect(url).toContain('/s/%D0%BC%D0%BE%D1%8F%20%D0%B8%D1%81%D1%82%D0%BE%D1%80%D0%B8%D1%8F?')
    expect(new URL(url).searchParams.get('q')).toBe('он сказал «да»')
  })
})

describe('readStoryQuoteTarget', () => {
  it('читает кадр и фразу из параметров', () => {
    expect(readStoryQuoteTarget('?frame=f1&q=%D0%90%D0%BD%D1%8F')).toEqual({
      frameId: 'f1',
      quote: 'Аня',
    })
  })

  it('кадр без фразы — осмысленная ссылка, фраза пустая', () => {
    expect(readStoryQuoteTarget('?frame=f1')).toEqual({ frameId: 'f1', quote: '' })
  })

  it('без кадра — обычная страница истории', () => {
    expect(readStoryQuoteTarget('')).toBeNull()
    expect(readStoryQuoteTarget('?q=%D0%90%D0%BD%D1%8F')).toBeNull()
    expect(readStoryQuoteTarget('?frame=%20')).toBeNull()
  })

  it('переживает кодирование: «ё», переносы и знаки', () => {
    const url = buildStoryQuoteUrl('http://localhost:5173', 'slug', {
      frameId: 'e-1',
      quote: 'Ёлка, «ёжик»\nи точка.',
    })
    const target = readStoryQuoteTarget(new URL(url).search)
    expect(target).toEqual({ frameId: 'e-1', quote: 'Ёлка, «ёжик»\nи точка.' })
  })
})
