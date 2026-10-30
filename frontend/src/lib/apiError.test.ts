import { describe, expect, it } from 'vitest'
import { setLang } from '../store/lang'
import { describeApiError } from './apiError'

describe('describeApiError', () => {
  it('различает таймаут и предлагает повторить', () => {
    const info = describeApiError({ name: 'TimeoutError', message: 'Request timed out: GET http://localhost/api/x' })
    expect(info.kind).toBe('timeout')
    expect(info.retryable).toBe(true)
    expect(info.title).toMatch(/не ответил/i)
  })

  it('сетевую ошибку показывает как потерю связи', () => {
    const info = describeApiError({ name: 'TypeError', message: 'Failed to fetch' })
    expect(info.kind).toBe('offline')
    expect(info.retryable).toBe(true)
  })

  it('404 — это «не найдено», повторять бессмысленно', () => {
    const info = describeApiError({ response: { status: 404 } })
    expect(info.kind).toBe('notFound')
    expect(info.retryable).toBe(false)
    expect(info.hint).toMatch(/сняли с публикации|устарела/i)
  })

  it('404 в каталоге резидентов говорит о человеке, а не об истории', () => {
    const info = describeApiError({ response: { status: 404 } }, 'person')
    expect(info.kind).toBe('notFound')
    expect(info.title).toMatch(/профиль/i)
    expect(info.hint).not.toMatch(/сняли с публикации|устарела/i)
  })

  it('отказ импорта показывает причину с сервера и не предлагает повтор', () => {
    const info = describeApiError(
      { response: { status: 400 }, message: 'слишком много файлов' },
      'import',
    )
    expect(info.title).toMatch(/импорт/i)
    expect(info.hint).toBe('слишком много файлов')
    expect(info.retryable).toBe(false)
  })

  it('5xx просит повторить, 403 — нет', () => {
    expect(describeApiError({ response: { status: 503 } })).toMatchObject({ kind: 'server', retryable: true })
    expect(describeApiError({ response: { status: 403 } })).toMatchObject({ kind: 'forbidden', retryable: false })
  })

  it('не падает на пустом значении и сохраняет текст неизвестной ошибки', () => {
    expect(describeApiError(undefined).kind).toBe('unknown')
    const info = describeApiError(new Error('странная поломка'))
    expect(info.kind).toBe('unknown')
    expect(info.hint).toContain('странная поломка')
  })

  /**
   * 0.126.0: описания ошибок — из словаря, язык третьим аргументом (по умолчанию русский, поэтому
   * проверки выше не тронуты). Заголовок и подсказку видит человек в плашке; на английском
   * интерфейсе они не должны оставаться русскими.
   */
  it('на английском заголовок и подсказка переведены', () => {
    const notFound = describeApiError({ response: { status: 404 } }, 'story', 'en')
    expect(notFound.title).toBe('Page not found')
    expect(notFound.hint).toContain('unpublished')

    const auth = describeApiError({ response: { status: 401 } }, 'story', 'en')
    expect(auth.title).toBe('Sign-in required')

    const forbidden = describeApiError({ response: { status: 403 } }, 'story', 'en')
    expect(forbidden.title).toBe('No access')

    // Сервер 400 при импорте: текст сервера показываем как есть, он не переводится.
    const importError = describeApiError(
      { response: { status: 400 }, message: 'слишком много файлов: больше 2000' },
      'import',
      'en',
    )
    expect(importError.title).toBe('The import failed')
    expect(importError.hint).toBe('слишком много файлов: больше 2000')
    setLang('ru')
  })

})
