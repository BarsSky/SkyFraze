import { afterEach, describe, expect, it } from 'vitest'

import { serverErrorMessage } from './client'

/**
 * Текст отказа сервера.
 *
 * Сервер объясняет отказы своими словами («в проекте занято 9.4 МБ из 10 МБ — файл
 * на 1.2 МБ не помещается»), и эти слова нужны человеку в панели редактора. ky
 * кладёт тело ответа в `response`, поэтому достаём его здесь — и обязательно
 * безопасно: не-JSON тело, пустой ответ и обычная ошибка без response не должны
 * бросать исключение по дороге к пользователю.
 */
function jsonResponse(body: unknown, status = 413): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  // Ничего: тесты не трогают общее состояние, Response создаётся в каждом тесте.
})

describe('serverErrorMessage', () => {
  it('достаёт текст ошибки из тела ответа', async () => {
    const error = { response: jsonResponse({ error: 'в проекте занято 9.4 МБ из 10.0 МБ — файл на 1.2 МБ не помещается' }) }
    expect(await serverErrorMessage(error)).toContain('не помещается')
  })

  it('409 с объяснением тоже читается: «файл прикреплён к кадрам»', async () => {
    const error = { response: jsonResponse({ error: 'файл прикреплён к 2 кадрам — сначала открепите его' }, 409) }
    expect(await serverErrorMessage(error)).toContain('прикреплён к 2 кадрам')
  })

  it('не-JSON тело не ломает разбор', async () => {
    const error = { response: new Response('<html>502</html>', { status: 502 }) }
    expect(await serverErrorMessage(error)).toBeNull()
  })

  it('ошибка без ответа (сеть, таймаут) — null, вызывающий скажет своё', async () => {
    expect(await serverErrorMessage(new TypeError('Failed to fetch'))).toBeNull()
    expect(await serverErrorMessage(undefined)).toBeNull()
    expect(await serverErrorMessage({ response: { clone: undefined } })).toBeNull()
  })

  it('пустое поле error не считается сообщением', async () => {
    expect(await serverErrorMessage({ response: jsonResponse({ error: '' }) })).toBeNull()
    expect(await serverErrorMessage({ response: jsonResponse({}) })).toBeNull()
  })
})
