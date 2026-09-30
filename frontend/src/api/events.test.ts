import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Ревизионная защита проекции дерева (Фаза 0.5).
 *
 * Контракт симметричен `PUT /events/state`: база уходит заголовком
 * `X-Skyfraze-Base-Revision`, сервер отвечает 428 без заголовка, 409 при
 * устаревшей базе (в заголовке `X-Skyfraze-Revision` — актуальная), 200 при
 * успехе. Проекция — полная замена дерева, поэтому без этой проверки устаревший
 * клиент сносил чужие строки.
 *
 * Сеть подменяется целиком: проверяем форму запроса и разбор ответа, без стенда.
 */
const mocks = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn() }))

vi.mock('./client', () => ({ http: { put: mocks.put, get: mocks.get } }))

import { BASE_REVISION_HEADER, REVISION_HEADER, getEventState, httpStatusOf, syncEventTree } from './events'

function resp(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers })
}

describe('syncEventTree', () => {
  beforeEach(() => mocks.put.mockReset())

  it('отправляет базовую ревизию тем же заголовком, что и снапшот', async () => {
    mocks.put.mockResolvedValue(resp(200))

    const result = await syncEventTree('p1', [
      { id: 'e1', parent_id: null, position: 0, title: 'Глава', body: 'текст' },
    ], 828)

    expect(result).toEqual({})
    const [url, options] = mocks.put.mock.calls[0]
    expect(url).toBe('projects/p1/events/tree')
    // PUT /events/state использует ровно этот заголовок — контракт один.
    expect(options.headers[BASE_REVISION_HEADER]).toBe('828')
    expect(options.throwHttpErrors).toBe(false)
    expect(options.json).toHaveLength(1)
  })

  it('без базы отправляет 0, а не пустой заголовок: сервер должен ответить 409, а не 428', async () => {
    mocks.put.mockResolvedValue(resp(409, { [REVISION_HEADER]: '828' }))

    const result = await syncEventTree('p1', [], 0)

    expect(mocks.put.mock.calls[0][1].headers[BASE_REVISION_HEADER]).toBe('0')
    expect(result).toEqual({ conflict: true, currentRevision: 828 })
  })

  it('409 отдаёт актуальную ревизию из заголовка', async () => {
    mocks.put.mockResolvedValue(resp(409, { [REVISION_HEADER]: '42' }))
    const result = await syncEventTree('p1', [], 7)
    expect(result.conflict).toBe(true)
    expect(result.currentRevision).toBe(42)
  })

  it('409 без заголовка ревизии не выдумывает число', async () => {
    mocks.put.mockResolvedValue(resp(409))
    const result = await syncEventTree('p1', [], 7)
    expect(result).toEqual({ conflict: true, currentRevision: undefined })
  })

  it('428 считает восстановимым случаем, а не ошибкой', async () => {
    mocks.put.mockResolvedValue(resp(428))
    const result = await syncEventTree('p1', [], 0)
    // Клиент по этому флагу перечитает состояние и повторит проекцию.
    expect(result).toEqual({ needsBase: true })
  })

  it('403 — это «только чтение», а не сбой сети', async () => {
    mocks.put.mockResolvedValue(resp(403))
    expect(await syncEventTree('p1', [], 1)).toEqual({ forbidden: true })
  })

  it('прочие коды бросают ошибку со статусом: 400 означает «структуру отвергнут»', async () => {
    mocks.put.mockResolvedValue(resp(400))
    await expect(syncEventTree('p1', [], 1)).rejects.toMatchObject({ status: 400 })
  })

  it('неожиданный код ответа не выдаётся за успешную проекцию', async () => {
    // 500 (и любой другой код, кроме 200/403/409/428) — ошибка: вызывающий
    // должен увидеть исключение, а не «проекция прошла».
    mocks.put.mockResolvedValue(resp(500))
    const caught = await syncEventTree('p1', [], 1).then(
      () => null,
      (e: unknown) => e,
    )
    expect(caught).toMatchObject({ status: 500 })
  })
})

describe('httpStatusOf', () => {
  it('достаёт статус и из ky-ошибки (response), и из простого поля status', () => {
    expect(httpStatusOf({ response: { status: 403 } })).toBe(403)
    expect(httpStatusOf({ status: 400 })).toBe(400)
    expect(httpStatusOf(new Error('нет статуса'))).toBeNull()
    expect(httpStatusOf(null)).toBeNull()
  })
})

describe('getEventState — источник базы для проекции', () => {
  beforeEach(() => mocks.get.mockReset())

  it('читает ревизию из заголовка ответа', async () => {
    mocks.get.mockResolvedValue({
      headers: new Headers({ [REVISION_HEADER]: '828' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })

    const snap = await getEventState('p1')
    expect(snap.revision).toBe(828)
    expect(Array.from(snap.state)).toEqual([1, 2, 3])
  })
})
