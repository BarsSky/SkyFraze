import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PublicStoryPage } from './PublicStoryPage'
import { setLang } from '../store/lang'

/**
 * Публичная история: ссылка на фразу (0.136.0).
 *
 * Два обещания, которые проверяются здесь, а не в e2e (тот смотрит только одну историю живьём):
 *   1) выделил фразу — получил адрес истории с кадром и фразой, и адрес показан целиком;
 *   2) открыл такой адрес — кадр открыт, фраза подсвечена.
 *
 * Сеть подменена одним ответом API: страница публичная и ничего не пишет. Подсветка в jsdom идёт
 * запасным путём через `<mark>` (CSS Custom Highlight API в jsdom нет) — это тот же путь, что
 * достанется браузерам без API.
 */

const STORY = {
  story: {
    id: 'p1',
    slug: 'prolog',
    title: 'Пролог',
    description: '',
    author: 'Аня',
    views: 5,
    rating_avg: 0,
    rating_count: 0,
    cover_asset_id: null,
    published_at: '2026-10-01T00:00:00Z',
  },
  assets: [],
  events: [
    {
      id: 'f1',
      parent_id: null,
      position: 0,
      title: 'Пролог',
      body: 'Аня вошла в дом и огляделась.',
    },
  ],
}

vi.mock('../api/feed', () => ({
  getPublicStory: async () => STORY,
  publicAssetUrl: (id: string) => `/api/public/assets/${id}`,
  listFeed: async () => ({ sort: 'new', items: [] }),
  rateStory: async () => ({ rating_avg: 1, rating_count: 1, my_rating: 1 }),
  unrateStory: async () => ({ rating_avg: 0, rating_count: 0, my_rating: null }),
  setPublication: async () => STORY.story,
}))

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) => selector({ user: null }),
}))

/** Под нагрузкой полного прогона страница успевает, а ожидание по умолчанию (1 с) — нет. */
const WAIT = { timeout: 15_000 }

const renderAt = (path: string) =>
  render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/s/:slug" element={<PublicStoryPage />} />
      </Routes>
    </MemoryRouter>,
  )

/** Выделить слово в тексте кадра: так на телефоне и на десктопе начинается меню. */
function selectWord(container: HTMLElement, text: string) {
  const root = container.matches('[data-frame-body]')
    ? container
    : container.querySelector('[data-frame-body]')
  if (!root) throw new Error('в кадре нет текста')
  const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode() as Text | null
  if (!node) throw new Error('нет текстового узла')
  const index = node.textContent?.indexOf(text) ?? -1
  if (index < 0) throw new Error(`«${text}» нет в тексте`)
  const range = document.createRange()
  range.setStart(node, index)
  range.setEnd(node, index + text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

beforeEach(() => {
  setLang('ru')
  // jsdom не считает геометрию: без прямоугольника меню не показывается вовсе.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 60,
      bottom: 30,
      width: 50,
      height: 10,
      toJSON: () => ({}),
    }),
  })
})

afterEach(() => {
  cleanup()
  setLang('ru')
  window.getSelection()?.removeAllRanges()
})

describe('публичная история — ссылка на фразу', () => {
  it('у читателя в меню одно действие, и оно даёт адрес с кадром и фразой', async () => {
    const view = renderAt('/s/prolog')
    const body = await waitFor(() => {
      const found = view.container.querySelector('[data-frame-body]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    }, WAIT)
    selectWord(body, 'вошла в дом')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Ссылка на фразу' })).toBeTruthy(), WAIT)
    expect(screen.queryByRole('button', { name: 'В чат проекта' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ссылка на фразу' }))

    const dialog = await screen.findByRole('dialog', { name: 'Ссылка на фразу' }, WAIT)
    expect(dialog).toBeTruthy()
    const field = screen.getByLabelText('Адрес ссылки') as HTMLInputElement
    expect(field.value).toContain('/s/prolog?')
    const params = new URL(field.value).searchParams
    expect(params.get('frame')).toBe('f1')
    expect(params.get('q')).toBe('вошла в дом')
    expect(field.readOnly).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }))
    // Буфер обмена в jsdom недоступен: страница честно говорит, что текст уже выделен.
    expect(await screen.findByRole('status', {}, WAIT)).toBeTruthy()
  })

  it('адрес с кадром и фразой открывает кадр с подсвеченной фразой', async () => {
    const view = renderAt('/s/prolog?frame=f1&q=%D0%B2%D0%BE%D1%88%D0%BB%D0%B0%20%D0%B2%20%D0%B4%D0%BE%D0%BC')
    await waitFor(() => expect(view.container.querySelector('[data-frame-body]')).toBeTruthy(), WAIT)
    // В jsdom подсветка идёт запасным путём — обёрткой в <mark>.
    await waitFor(() => {
      const mark = view.container.querySelector('[data-quote-mark]')
      expect(mark).toBeTruthy()
      expect(mark!.textContent).toBe('вошла в дом')
    }, WAIT)
  })

  it('адрес без фразы просто открывает историю, подсветки нет', async () => {
    const view = renderAt('/s/prolog')
    await waitFor(() => expect(view.container.querySelector('[data-frame-body]')).toBeTruthy())
    expect(view.container.querySelector('[data-quote-mark]')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
