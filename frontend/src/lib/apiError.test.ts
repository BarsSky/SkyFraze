import { describe, expect, it } from 'vitest'
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
})
