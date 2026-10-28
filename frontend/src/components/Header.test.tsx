import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Header } from './Header'
import { useAuthStore } from '../store/auth'

/**
 * Шапка на узком экране (0.78.0).
 *
 * Что закрепляем: на телефоне лишние разделы лежат в меню «Ещё», а НЕ уезжают за правый край
 * прокруткой. Замер до правки: при экране 390 px правые края «Резидентов» и «Админки» были
 * 469 и 562 px — то есть за экраном, без полосы прокрутки и без признака, что они есть.
 */

vi.mock('./NotificationBell', () => ({ NotificationBell: () => null }))

const ADMIN = {
  id: 'u1',
  email: 'admin@example.com',
  display_name: 'Админ',
  username: 'admin',
  is_admin: true,
}

/**
 * Подмена медиа-запроса: jsdom не считает ширину, поэтому говорим прямо, какой это экран.
 * Запросы разбираем по-настоящему (`max-width: Npx`), иначе «телефон» и «совсем узкий телефон»
 * совпали бы одновременно, и шапка спрятала бы в меню даже главный пункт.
 */
function stubViewport(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const limit = /max-width:\s*(\d+)px/.exec(query)
    const matches = limit ? width <= Number(limit[1]) : false
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }
  })
}

function renderHeader(path = '/projects') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
      <Routes>
        <Route path="*" element={<div data-testid="where">{path}</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useAuthStore.setState({ user: ADMIN as never })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Header — навигация на узком экране', () => {
  it('на широком экране все разделы в строке, меню «Ещё» нет', async () => {
    stubViewport(1200)
    const view = renderHeader()
    const nav = view.container.querySelector('nav') as HTMLElement
    expect(within(nav).getByText('Резиденты')).toBeTruthy()
    expect(within(nav).getByText('Админка')).toBeTruthy()
    expect(view.container.querySelector('[data-header-more]')).toBeNull()
  })

  it('на телефоне в строке остаются главные пункты, остальное — в меню', async () => {
    stubViewport(480)
    const view = renderHeader()
    const nav = view.container.querySelector('nav') as HTMLElement
    // В строке: «Мои проекты» и кнопка «Ещё». Ни «Резиденты», ни «Админка» за краем не висят.
    const inlineLinks = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)
    expect(inlineLinks).toEqual(['Мои проекты'])
    expect(within(nav).getByRole('button', { name: 'Ещё разделы' })).toBeTruthy()
    expect(within(nav).queryByText('Резиденты')).toBeNull()
  })

  it('меню раскрывается, показывает разделы и закрывается по Escape', async () => {
    stubViewport(480)
    const view = renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Резиденты')).toBeTruthy()
    expect(within(menu).getByText('Админка')).toBeTruthy()
    expect(within(menu).getByText('Лента')).toBeTruthy()
    expect(within(menu).getByText('Соавторы')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(view.container.querySelector('[data-header-more]')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('админского пункта нет у обычного человека', async () => {
    stubViewport(480)
    useAuthStore.setState({ user: { ...ADMIN, is_admin: false } as never })
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText('Админка')).toBeNull()
    expect(within(menu).getByText('Резиденты')).toBeTruthy()
  })

  it('анонимному видна только лента, меню не нужно', async () => {
    stubViewport(1200)
    useAuthStore.setState({ user: null })
    const view = renderHeader('/feed')
    const nav = view.container.querySelector('nav') as HTMLElement
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['Лента'])
    expect(view.container.querySelector('[data-header-more]')).toBeNull()
  })

  /**
   * 320 px: в строке помещается только «Ещё». Прежде кнопка меню вылезала из своей полосы и
   * перекрывала переключатель темы — клик по теме попадал в меню (нашёл аудит интерфейса).
   */
  it('на 320 px в строке только «Ещё», а главный раздел — первым в меню', async () => {
    stubViewport(320)
    const view = renderHeader()
    const nav = view.container.querySelector('nav') as HTMLElement
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual([])
    fireEvent.click(within(nav).getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
    expect(items[0]).toBe('Мои проекты')
    expect(items).toContain('Резиденты')
    expect(items).toContain('Админка')
  })
})

/**
 * Высота шапки — в CSS-переменной (0.86.0).
 *
 * Отчёт: «меню накрывает кнопки переключения» на вкладке «Версии». Причина: переменную
 * `--sf-header-h` ставила стадия проекта, а с 0.83.0 она живёт только на вкладке «Проект» —
 * на остальных её размонтирование СНИМАЛО переменную, и полоса вкладок вставала на запасные
 * 46 px под реальной шапкой 62 px: верх вкладок был скрыт. Теперь меряет сама шапка.
 */
describe('Header — высота шапки для фиксированных слоёв', () => {
  it('отдаёт свою высоту в --sf-header-h и убирает её при размонтировании', () => {
    stubViewport(1200)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, width: 1200, height: 62, top: 0, left: 0, right: 1200, bottom: 62,
      toJSON: () => ({}),
    } as DOMRect)
    const view = renderHeader()
    expect(document.documentElement.style.getPropertyValue('--sf-header-h')).toBe('62px')
    view.unmount()
    expect(document.documentElement.style.getPropertyValue('--sf-header-h')).toBe('')
    vi.restoreAllMocks()
  })
})
