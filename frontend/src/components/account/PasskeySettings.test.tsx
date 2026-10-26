import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PasskeySettings, describeKey } from './PasskeySettings'

/**
 * Ключи доступа в профиле.
 *
 * Проверяем то, что человек делает руками и на чём легко ошибиться: привязка просит имя и
 * показывает коды восстановления один раз, удаление требует подтверждения (иначе один
 * случайный клик отрезает устройство), а браузер без WebAuthn получает объяснение вместо
 * кнопки, которая не работает.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  describe: vi.fn(),
  supported: true,
}))

vi.mock('../../api/webauthn', () => ({
  listPasskeys: mocks.list,
  addPasskey: mocks.add,
  deletePasskey: mocks.remove,
  describePasskeyError: mocks.describe,
  passkeysSupported: () => mocks.supported,
}))

let currentUser: Record<string, unknown> = {
  id: 'u1',
  email: 'me@example.com',
  passkeys_enabled: true,
}

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) => selector({ user: currentUser }),
}))

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  name: 'ноутбук',
  created_at: new Date().toISOString(),
  transports: 'internal',
  ...over,
})

beforeEach(() => {
  currentUser = { id: 'u1', email: 'me@example.com', passkeys_enabled: true }
  mocks.supported = true
  mocks.list.mockReset().mockResolvedValue([])
  mocks.add.mockReset()
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.describe.mockReset().mockResolvedValue('Ключ не подтверждён — окно закрылось.')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PasskeySettings', () => {
  it('без поддержки на стенде блок не показывается вовсе', () => {
    currentUser = { id: 'u1', email: 'me@example.com', passkeys_enabled: false }
    const { container } = render(<PasskeySettings />)
    expect(container.textContent).toBe('')
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('пустой список объясняет, зачем привязывать два ключа', async () => {
    render(<PasskeySettings />)
    expect(await screen.findByText(/Ключей пока нет/)).toBeTruthy()
    expect(screen.getByText(/телефон и ноутбук/)).toBeTruthy()
  })

  it('показывает привязанные ключи с именем и датой', async () => {
    mocks.list.mockResolvedValue([
      key(),
      key({ id: 'k2', name: 'телефон', transports: 'hybrid', last_used_at: new Date().toISOString() }),
    ])
    render(<PasskeySettings />)
    expect(await screen.findByText('ноутбук')).toBeTruthy()
    expect(screen.getByText('телефон')).toBeTruthy()
    // Оба ключа привязаны сегодня — подпись у каждого своя.
    expect(screen.getAllByText(/привязан сегодня/)).toHaveLength(2)
    expect(screen.getByText(/телефон как ключ/)).toBeTruthy()
  })

  it('привязка: имя уходит на сервер, ключ появляется в списке, коды показываются', async () => {
    mocks.add.mockResolvedValue({
      key: key({ id: 'k9', name: 'ключ в телефоне' }),
      recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-STUVW'],
    })
    render(<PasskeySettings />)
    await screen.findByText(/Ключей пока нет/)

    fireEvent.change(screen.getByLabelText('Имя ключа'), { target: { value: 'телефон' } })
    fireEvent.click(screen.getByRole('button', { name: /Привязать ключ/ }))

    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith('телефон'))
    expect(await screen.findByText('ключ в телефоне')).toBeTruthy()
    // Коды восстановления — один раз и сразу: это последний путь в аккаунт.
    expect(screen.getByText('ABCDE-FGHJK')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Я сохранил коды' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Я сохранил коды' }))
    expect(screen.queryByText('ABCDE-FGHJK')).toBeNull()
  })

  it('отказ браузера объясняется словами, а не кодом ошибки', async () => {
    mocks.add.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    render(<PasskeySettings />)
    await screen.findByText(/Ключей пока нет/)
    fireEvent.click(screen.getByRole('button', { name: /Привязать ключ/ }))
    expect(await screen.findByText(/Ключ не подтверждён/)).toBeTruthy()
    // Ключ не добавился.
    expect(screen.queryByText('ключ в телефоне')).toBeNull()
  })

  it('удаление требует подтверждения и только потом зовёт сервер', async () => {
    mocks.list.mockResolvedValue([key()])
    render(<PasskeySettings />)
    expect(await screen.findByText('ноутбук')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Удалить ключ ноутбук'))
    expect(mocks.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('k1'))
    expect(await screen.findByText(/Ключ удалён/)).toBeTruthy()
    expect(screen.queryByText('ноутбук')).toBeNull()
  })

  it('«оставить» отменяет удаление и ничего не удаляет', async () => {
    mocks.list.mockResolvedValue([key()])
    render(<PasskeySettings />)
    await screen.findByText('ноутбук')

    fireEvent.click(screen.getByLabelText('Удалить ключ ноутбук'))
    fireEvent.click(screen.getByRole('button', { name: 'Оставить' }))
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(screen.getByText('ноутбук')).toBeTruthy()
  })

  it('браузер без WebAuthn: объяснение вместо кнопки привязки', async () => {
    mocks.supported = false
    render(<PasskeySettings />)
    expect(await screen.findByText(/Этот браузер не поддерживает ключи доступа/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Привязать ключ/ })).toBeNull()
  })
})

describe('describeKey', () => {
  const now = new Date('2026-10-26T12:00:00Z')

  it('считает свежие даты относительными', () => {
    // Транспорт отдельно: здесь проверяется только дата.
    const dated = (created: string) => describeKey(key({ created_at: created, transports: '' }), now)
    expect(dated('2026-10-26T09:00:00Z')).toBe('привязан сегодня')
    expect(dated('2026-10-25T09:00:00Z')).toBe('привязан вчера')
    expect(dated('2026-10-20T09:00:00Z')).toBe('привязан 6 дн. назад')
  })

  it('показывает последний вход и тип подключения', () => {
    const text = describeKey(
      key({ created_at: '2026-09-01T09:00:00Z', last_used_at: '2026-10-26T10:00:00Z', transports: 'usb' }),
      now,
    )
    expect(text).toContain('вход сегодня')
    expect(text).toContain('USB-ключ')
  })

  it('пустые и битые даты не превращаются в «Invalid Date»', () => {
    expect(describeKey(key({ created_at: '', last_used_at: undefined, transports: '' }), now)).toBe('')
    expect(describeKey(key({ created_at: 'не дата', transports: '' }), now)).toBe('')
  })
})
