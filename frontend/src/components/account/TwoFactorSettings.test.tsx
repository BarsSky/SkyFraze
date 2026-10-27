import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TwoFactorSettings, sessionDescription } from './TwoFactorSettings'

/**
 * Второй фактор входа в профиле.
 *
 * Проверяем то, что человек реально делает и на чём легко ошибиться: включение показывает
 * секрет и требует код, коды восстановления показываются ОДИН раз, выключение требует кода
 * (а не просто нажатия), и «выйти на всех устройствах» ничего не делает молча.
 */

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  sessions: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('../../api/auth', () => ({
  setupTOTP: mocks.setup,
  enableTOTP: mocks.enable,
  disableTOTP: mocks.disable,
  listSessions: mocks.sessions,
  revokeOtherSessions: mocks.revoke,
  // Журнал входов живёт в том же блоке: без него компонент ловит TypeError и показывает
  // пустой список, то есть тест проверял бы не то, что видит человек.
  listLogins: async () => ({ attempts: [], retentionDays: 90 }),
}))

let currentUser: Record<string, unknown> = { id: 'u1', email: 'me@example.com', totp_enabled: false }
const setUser = vi.fn((u: Record<string, unknown>) => {
  currentUser = u
})

vi.mock('../../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown; setUser: unknown }) => unknown) =>
    selector({ user: currentUser, setUser }),
}))

beforeEach(() => {
  currentUser = { id: 'u1', email: 'me@example.com', totp_enabled: false }
  mocks.setup.mockResolvedValue({
    secret: 'JBSWY3DPEHPK3PXP',
    url: 'otpauth://totp/SkyFraze:me@example.com?secret=JBSWY3DPEHPK3PXP',
  })
  mocks.enable.mockResolvedValue({ recovery_codes: ['ABCDE-FGHJK', 'MNPQR-STUVW'] })
  mocks.disable.mockResolvedValue(undefined)
  mocks.sessions.mockResolvedValue([
    {
      id: 's1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
      ip: '203.0.113.7',
      createdAt: '2026-10-25T08:00:00Z',
      expiresAt: '2026-11-24T08:00:00Z',
    },
  ])
  mocks.revoke.mockResolvedValue(2)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TwoFactorSettings', () => {
  it('включение: показывает секрет, затем одноразовые коды восстановления', async () => {
    render(<TwoFactorSettings />)
    expect(await screen.findByText('выключен')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Включить двухфакторный вход/ }))
    await waitFor(() => expect(mocks.setup).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Код подтверждения'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }))
    await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('123456'))
    // Коды показаны и профиль помечен «включён».
    expect(await screen.findByText('ABCDE-FGHJK')).toBeTruthy()
    expect(screen.getByText('MNPQR-STUVW')).toBeTruthy()
    expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: true }))
  })

  it('неверный код не включает второй фактор и объясняет, что делать', async () => {
    mocks.enable.mockRejectedValue(new Error('bad code'))
    render(<TwoFactorSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Включить двухфакторный вход/ }))
    await screen.findByText('JBSWY3DPEHPK3PXP')
    fireEvent.change(screen.getByLabelText('Код подтверждения'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }))
    expect(await screen.findByText(/Код не подошёл/)).toBeTruthy()
    // Коды восстановления не показаны — включения не было.
    expect(screen.queryByText('ABCDE-FGHJK')).toBeNull()
    expect(setUser).not.toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: true }))
  })

  it('выключение требует код и при отказе оставляет защиту', async () => {
    currentUser = { id: 'u1', email: 'me@example.com', totp_enabled: true }
    mocks.disable.mockRejectedValueOnce(new Error('bad code'))
    render(<TwoFactorSettings />)
    expect(await screen.findByText('включён')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Код для отключения'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Выключить' }))
    expect(await screen.findByText(/вход остался двухфакторным/)).toBeTruthy()
    expect(setUser).not.toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: false }))

    fireEvent.change(screen.getByLabelText('Код для отключения'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Выключить' }))
    await waitFor(() => expect(mocks.disable).toHaveBeenLastCalledWith('654321'))
    expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ totp_enabled: false }))
  })

  it('сеансы видны и «выйти на всех» сообщает результат', async () => {
    render(<TwoFactorSettings />)
    // Сеанс подписан браузером и адресом, а не голым идентификатором.
    expect(await screen.findByText(/Chrome · Windows · 203\.0\.113\.7/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Выйти на всех устройствах/ }))
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Закрыто сеансов: 2/)).toBeTruthy()
  })
})

describe('sessionDescription', () => {
  it('распознаёт браузер и систему, не пугая пустой строкой', () => {
    expect(
      sessionDescription({
        id: 's',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0',
        ip: '',
        createdAt: '2026-10-25T08:00:00Z',
        expiresAt: '',
      }),
    ).toContain('Firefox · Linux')
    // Неизвестный user-agent — честная подпись, а не пустая строка.
    expect(
      sessionDescription({ id: 's', userAgent: '', ip: '', createdAt: '', expiresAt: '' }),
    ).toBe('Неизвестный браузер')
  })
})
