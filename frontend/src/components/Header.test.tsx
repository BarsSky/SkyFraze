import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Header } from './Header'
import { useAuthStore } from '../store/auth'
import { setLang } from '../store/lang'

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
  // Язык — модульное состояние: без сброса тест, переключивший язык, «покрасил» бы соседние.
  setLang('ru')
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
    // «Профиль» — в строке (0.99.0), и он ведёт на свою страницу, а не на «Соавторов».
    const profile = within(nav).getByRole('link', { name: 'Профиль' })
    expect(profile.getAttribute('href')).toBe('/profile')
    expect(view.container.querySelector('[data-header-more]')).toBeNull()
  })

  it('имя в шапке ведёт в профиль, а не в соавторов (0.99.0)', () => {
    stubViewport(1200)
    const view = renderHeader()
    const nameLink = view.container.querySelector('.header-user') as HTMLAnchorElement
    expect(nameLink.getAttribute('href')).toBe('/profile')
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
    // Своя учётная запись — отдельным пунктом (0.99.0): до этого профиля в навигации не было,
    // а всё про вход жило на странице «Соавторы».
    expect(within(menu).getByText('Профиль')).toBeTruthy()

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

  it('анонимному видны лента и «О проекте» (0.114.0), остальное требует входа', async () => {
    stubViewport(1200)
    useAuthStore.setState({ user: null })
    const view = renderHeader('/feed')
    const nav = view.container.querySelector('nav') as HTMLElement
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      'Лента',
      'О проекте',
    ])
    expect(view.container.querySelector('[data-header-more]')).toBeNull()
  })

  it('«О проекте» есть у вошедшего и на телефоне живёт в меню (0.114.0)', async () => {
    stubViewport(480)
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    const about = within(menu).getByRole('menuitem', { name: 'О проекте' })
    expect(about.getAttribute('href')).toBe('/about')
  })

  /**
   * Переключатель языка (0.115.0): подписи меняются БЕЗ перезагрузки, и на совсем узком экране
   * кнопка уезжает в меню «Ещё» — там же, где тема и выход.
   */
  it('переключатель EN/RU меняет подписи на месте', async () => {
    stubViewport(1200)
    renderHeader()
    expect(within(screen.getByRole('navigation')).getByText('Мои проекты')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Переключить язык' }))
    // Английские подписи: навигация, шапка и всё, что переводится в фазе 1.
    expect(within(screen.getByRole('navigation')).getByText('My projects')).toBeTruthy()
    expect(screen.queryByText('Мои проекты')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    expect(within(screen.getByRole('navigation')).getByText('Мои проекты')).toBeTruthy()
  })

  it('на 320 px язык переключается пунктом меню', async () => {
    stubViewport(320)
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Переключить язык' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'English' }))
    // Меню закрылось, подписи английские.
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }))
    const enMenu = await screen.findByRole('menu')
    expect(within(enMenu).getByRole('menuitem', { name: 'Residents' })).toBeTruthy()
    expect(within(enMenu).getByRole('menuitem', { name: 'Русский' })).toBeTruthy()
  })

  /**
   * 320 px (0.88.0): в строке остаётся главный раздел, а тема и выход переезжают в меню.
   *
   * До этого на совсем узком экране в строке была ОДНА кнопка «Ещё» — шапка выглядела пустой
   * (отчёт: «из меню видно только кнопку Ещё и больше ничего»).
   */
  it('на 320 px в строке «Мои проекты», а тема и выход — в меню', async () => {
    stubViewport(320)
    const view = renderHeader()
    const nav = view.container.querySelector('nav') as HTMLElement
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['Мои проекты'])
    // Переключателя темы и «Выйти» в строке нет: место отдано разделу.
    expect(screen.queryByLabelText('Переключить тему')).toBeNull()
    expect(within(nav).queryByRole('button', { name: 'Выйти' })).toBeNull()

    fireEvent.click(within(nav).getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim())
    // «Мои проекты» уже в строке — в меню его нет; остальные разделы на месте, действия — в конце.
    expect(items).not.toContain('Мои проекты')
    expect(items).toContain('Лента')
    expect(items).toContain('Резиденты')
    expect(items).toContain('Админка')
    // Подпись темы зависит от текущей («Светлая тема» / «Тёмная тема») — проверяем по смыслу.
    expect(items.some((item) => item !== undefined && /тема/i.test(item))).toBe(true)
    expect(items[items.length - 1]).toBe('Выйти')
  })

  it('в меню на узком экране тема переключает тему, а не только показывает пункт', async () => {
    stubViewport(320)
    renderHeader()
    const before = document.documentElement.dataset.theme
    fireEvent.click(screen.getByRole('button', { name: 'Ещё разделы' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /тема/ }))
    await waitFor(() => expect(document.documentElement.dataset.theme).not.toBe(before))
    expect(screen.queryByRole('menu')).toBeNull()
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
