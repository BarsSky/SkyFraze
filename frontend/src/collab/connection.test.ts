import { describe, expect, it } from 'vitest'
import { OFFLINE_AFTER_ATTEMPTS, connectionNotice } from './connection'

/**
 * Правило «что показать человеку»: временный разрыв и «realtime тут недоступен» —
 * разные сообщения. Раньше наружу торчал только булев `connected`, и отличить
 * одно от другого интерфейс не мог.
 */
describe('connectionNotice', () => {
  it('на живом соединении и на первом подключении ничего не показываем', () => {
    expect(connectionNotice('open', 0)).toBeNull()
    expect(connectionNotice('connecting', 0)).toBeNull()
  })

  it('после обрыва обещаем переподключение, а не потерю связи', () => {
    const note = connectionNotice('reconnecting', 1)
    expect(note).toContain('переподключаюсь')
  })

  it('когда повторы не помогают — честно говорим, что realtime недоступен', () => {
    const note = connectionNotice('offline', OFFLINE_AFTER_ATTEMPTS)
    expect(note).toContain('realtime недоступен')
    // Важно для человека: правки не теряются, их просто увидят позже.
    expect(note).toContain('сохраняются')
  })

  it('offline до порога попыток ещё не приговор', () => {
    expect(connectionNotice('offline', 0)).toContain('переподключаюсь')
  })
})
