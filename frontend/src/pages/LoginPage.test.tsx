import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LoginPage } from './LoginPage'

/**
 * Экран входа и его второй шаг.
 *
 * Главное, что проверяется: после пароля человек видит ровно те способы, которые у него есть —
 * код из приложения, ключ доступа или оба. Ошибка здесь не косметическая: кнопка «войти
 * ключом» без привязанного ключа ведёт в тупик, а её отсутствие у человека с ключом означает
 * «вход сломан».
 */

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginTOTP: vi.fn(),
  loginWithPasskey: vi.fn(),
  describePasskeyError: vi.fn(),
  supported: true,
}))

vi.mock('../api/auth', () => ({
  login: mocks.login,
  loginTOTP: mocks.loginTOTP,
}))

vi.mock('../api/webauthn', () => ({
  loginWithPasskey: mocks.loginWithPasskey,
  describePasskeyError: mocks.describePasskeyError,
  passkeysSupported: () => mocks.supported,
}))

const page = () =>
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LoginPage />
    </MemoryRouter>,
  )

/** Первый шаг: email, пароль, «Войти» — и сервер говорит, что нужен второй. */
async function reachSecondStep(twoFactor: { totp: boolean; passkeys: boolean } | null) {
  mocks.login.mockResolvedValue(
    twoFactor === null
      ? { kind: 'two-factor', challenge: 'ticket-1', totp: false, passkeys: false }
      : { kind: 'two-factor', challenge: 'ticket-1', ...twoFactor },
  )
  page()
  fireEvent.change(screen.getByPlaceholderText('email'), { target: { value: 'me@example.com' } })
  fireEvent.change(screen.getByPlaceholderText('пароль'), { target: { value: 'hunter22!' } })
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
  await waitFor(() => expect(mocks.login).toHaveBeenCalled())
  await screen.findByText(/Пароль принят/)
}

beforeEach(() => {
  mocks.supported = true
  mocks.login.mockReset()
  mocks.loginTOTP.mockReset().mockResolvedValue({ id: 'u1' })
  mocks.loginWithPasskey.mockReset().mockResolvedValue({ id: 'u1' })
  mocks.describePasskeyError.mockReset().mockResolvedValue('Ключ не подтверждён — окно закрылось.')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LoginPage — второй шаг', () => {
  it('код и ключ: видны оба способа', async () => {
    await reachSecondStep({ totp: true, passkeys: true })
    expect(screen.getByRole('button', { name: 'Войти ключом доступа' })).toBeTruthy()
    expect(screen.getByLabelText('Код двухфакторного входа')).toBeTruthy()
  })

  it('только ключ: поля кода нет — кода у человека не существует', async () => {
    await reachSecondStep({ totp: false, passkeys: true })
    expect(screen.getByRole('button', { name: 'Войти ключом доступа' })).toBeTruthy()
    expect(screen.queryByLabelText('Код двухфакторного входа')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).toBeNull()
  })

  it('только код: кнопки ключа нет', async () => {
    await reachSecondStep({ totp: true, passkeys: false })
    expect(screen.getByLabelText('Код двухфакторного входа')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Войти ключом доступа' })).toBeNull()
  })

  it('старый сервер без признаков: код остаётся единственным способом', async () => {
    await reachSecondStep(null)
    expect(screen.getByLabelText('Код двухфакторного входа')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Войти ключом доступа' })).toBeNull()
  })

  it('ключ не поддержан браузером — кнопки нет, код есть', async () => {
    mocks.supported = false
    await reachSecondStep({ totp: true, passkeys: true })
    expect(screen.queryByRole('button', { name: 'Войти ключом доступа' })).toBeNull()
    expect(screen.getByLabelText('Код двухфакторного входа')).toBeTruthy()
  })

  it('кнопка ключа передаёт пропуск второго шага и в случае отказа объясняет причину', async () => {
    await reachSecondStep({ totp: true, passkeys: true })
    mocks.loginWithPasskey.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    fireEvent.click(screen.getByRole('button', { name: 'Войти ключом доступа' }))
    await waitFor(() => expect(mocks.loginWithPasskey).toHaveBeenCalledWith('ticket-1'))
    expect(await screen.findByText(/Ключ не подтверждён/)).toBeTruthy()
  })

  it('«Назад» возвращает к паролю и не отправляет код', async () => {
    await reachSecondStep({ totp: true, passkeys: true })
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(screen.getByPlaceholderText('пароль')).toBeTruthy()
    expect(mocks.loginTOTP).not.toHaveBeenCalled()
  })
})
