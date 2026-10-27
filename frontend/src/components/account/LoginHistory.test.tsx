import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LoginHistory, describeLoginAttempt, describeLoginPlace } from './LoginHistory'

/**
 * Журнал входов в профиле.
 *
 * Проверяем то, ради чего он существует: человек видит, ЧЕМ входил (пароль, код, код
 * восстановления, ключ), замечает НЕУДАЧНЫЕ попытки и понимает, докуда журнал помнит. Ошибка
 * здесь не косметическая: «неудачная попытка» и «вход по коду восстановления» — разные события,
 * и именно они нужны, чтобы понять «в мой аккаунт лезут».
 */

const mocks = vi.hoisted(() => ({ logins: vi.fn() }))

vi.mock('../../api/auth', () => ({ listLogins: mocks.logins }))

const attempt = (over: Record<string, string> = {}) => ({
  id: 'a1',
  outcome: 'ok',
  factor: 'password',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
  createdAt: '2026-10-26T09:15:00Z',
  ...over,
})

beforeEach(() => {
  mocks.logins.mockReset().mockResolvedValue({ attempts: [], retentionDays: 90 })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LoginHistory', () => {
  it('пустой журнал объясняет, что здесь появится', async () => {
    render(<LoginHistory />)
    expect(await screen.findByText(/Записей пока нет/)).toBeTruthy()
    expect(screen.getByText(/неудачные попытки тоже/)).toBeTruthy()
  })

  it('показывает входы словами и с местом действия', async () => {
    mocks.logins.mockResolvedValue({
      attempts: [
        attempt(),
        attempt({ id: 'a2', factor: 'totp', createdAt: '2026-10-25T18:00:00Z' }),
        attempt({ id: 'a3', factor: 'passkey' }),
      ],
      retentionDays: 90,
    })
    render(<LoginHistory />)
    expect(await screen.findByText('Вход по паролю')).toBeTruthy()
    expect(screen.getByText('Вход по коду из приложения')).toBeTruthy()
    expect(screen.getByText('Вход по ключу доступа')).toBeTruthy()
    // Браузер, адрес и дата — в одной подписи, а не тремя колонками.
    expect(screen.getAllByText(/Chrome · Windows · 203\.0\.113\.7/).length).toBeGreaterThan(0)
  })

  it('неудачная попытка видна как неудачная', async () => {
    mocks.logins.mockResolvedValue({
      attempts: [attempt({ outcome: 'bad_password', factor: '' })],
      retentionDays: 90,
    })
    const { container } = render(<LoginHistory />)
    expect(await screen.findByText(/Неудачно: неверный пароль/)).toBeTruthy()
    // Класс — то, чем интерфейс помечает отказ; проверяем именно его, а не только текст.
    expect(container.querySelector('.logins__item--failed')).not.toBeNull()
  })

  it('говорит, сколько записей и за сколько дней хранится', async () => {
    mocks.logins.mockResolvedValue({ attempts: [attempt()], retentionDays: 90 })
    render(<LoginHistory />)
    expect(await screen.findByText(/за 90 дней/)).toBeTruthy()
    expect(screen.getByText(/Не узнаёте вход/)).toBeTruthy()
  })

  it('поломка журнала не ломает блок', async () => {
    mocks.logins.mockRejectedValue(new Error('network'))
    render(<LoginHistory />)
    expect(await screen.findByText(/Записей пока нет/)).toBeTruthy()
  })
})

describe('describeLoginAttempt', () => {
  const withOutcome = (outcome: string, factor = '') =>
    describeLoginAttempt(attempt({ outcome, factor }))

  it('различает факторы успешного входа', () => {
    expect(withOutcome('ok', 'password')).toBe('Вход по паролю')
    expect(withOutcome('ok', 'totp')).toBe('Вход по коду из приложения')
    // Код восстановления — отдельная строка: «вошёл по листку» это сигнал, а не деталь.
    expect(withOutcome('ok', 'recovery')).toBe('Вход по коду восстановления')
    expect(withOutcome('ok', 'passkey')).toBe('Вход по ключу доступа')
  })

  it('все отказы объяснены словами', () => {
    expect(withOutcome('bad_password')).toMatch(/неверный пароль/)
    expect(withOutcome('bad_code')).toMatch(/неверный код/)
    expect(withOutcome('bad_key')).toMatch(/ключ не подошёл/)
    expect(withOutcome('locked')).toMatch(/слишком много попыток/)
  })

  it('незнакомый исход не прячется за пустой строкой', () => {
    expect(withOutcome('что-то-новое')).toBe('Неизвестная попытка')
  })
})

describe('describeLoginPlace', () => {
  it('склеивает браузер, адрес и дату', () => {
    const text = describeLoginPlace(
      attempt({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121', ip: '198.51.100.4' }),
    )
    expect(text).toContain('Firefox · Linux')
    expect(text).toContain('198.51.100.4')
  })

  it('без данных отдаёт пустую строку, а не «Invalid Date»', () => {
    expect(describeLoginPlace(attempt({ userAgent: '', ip: '', createdAt: '' }))).toBe(
      'Неизвестный браузер',
    )
    expect(describeLoginPlace(attempt({ userAgent: '', ip: '', createdAt: 'не дата' }))).toBe(
      'Неизвестный браузер',
    )
  })
})
