import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BootSplash } from './BootSplash'
import { RequireAuth } from './RequireAuth'
import { useAuthStore } from '../store/auth'

/**
 * Заставка загрузки (0.80.0).
 *
 * Зачем тесты: это первое, что видит человек на перезагрузке, а раньше на её месте была пустота
 * — «перезагрузка долгая». Проверяем, что заставка есть до проверки входа и что она не пустая
 * (есть текст состояния для скринридера).
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // Возвращаем настоящий bootstrap: `setState` подменяет действие в общем сторе.
  useAuthStore.setState({ bootstrap: realBootstrap })
})

const realBootstrap = useAuthStore.getState().bootstrap

/** `RequireAuth` умеет редиректить, поэтому ему нужен роутер — как в приложении. */
function renderAuth(children: React.ReactNode) {
  return render(<MemoryRouter>{<RequireAuth>{children}</RequireAuth>}</MemoryRouter>)
}

describe('BootSplash', () => {
  it('показывает название и состояние словами', () => {
    const { container } = render(<BootSplash note="Загружаю оболочку…" />)
    const block = container.querySelector('[data-boot]')
    expect(block).toBeTruthy()
    expect(block?.getAttribute('role')).toBe('status')
    expect(screen.getByText('SkyFraze')).toBeTruthy()
    expect(screen.getByText('Загружаю оболочку…')).toBeTruthy()
  })
})

describe('RequireAuth — до готовности входа', () => {
  it('показывает заставку, а не пустоту', () => {
    // bootstrap подменяем: настоящий тут же сбросит вход и уведёт на /login — а проверяем мы
    // именно состояние «вход ещё проверяется».
    useAuthStore.setState({
      ready: false,
      refreshToken: 'r',
      user: null,
      bootstrap: async () => undefined,
    })
    const { container } = renderAuth(<p>Содержимое</p>)
    expect(container.querySelector('[data-boot]')).toBeTruthy()
    expect(screen.getByText('Проверяю вход…')).toBeTruthy()
    expect(screen.queryByText('Содержимое')).toBeNull()
  })

  it('после проверки показывает страницу', () => {
    useAuthStore.setState({ ready: true, refreshToken: 'r', user: null })
    renderAuth(<p>Содержимое</p>)
    expect(screen.getByText('Содержимое')).toBeTruthy()
    expect(document.querySelector('[data-boot]')).toBeNull()
  })
})
