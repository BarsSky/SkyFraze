import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FeedPage } from './FeedPage'
import { RatingStars } from '../components/RatingStars'
import { ImageViewer } from '../components/ImageViewer'
import { setLang } from '../store/lang'

/**
 * Публичный контур: лента, звёзды и просмотрщик картинок (0.127.0).
 *
 * Проверяем то, ради чего эти экраны переведены: английский читатель видит английские
 * подписи, а данные автора («Аня», название истории) остаются как их написал человек.
 * Сеть подменена: у ленты это один список, у звёзд — обратный вызов.
 */

vi.mock('../api/feed', () => ({
  listFeed: async () => ({
    sort: 'new',
    items: [
      {
        id: 'f1',
        slug: 'prolog',
        title: 'Пролог',
        description: '',
        author: 'Аня',
        views: 12,
        rating_avg: 4.5,
        rating_count: 2,
        cover_asset_id: null,
        published_at: '2026-10-01T00:00:00Z',
      },
    ],
  }),
  publicAssetUrl: (id: string) => `/api/public/assets/${id}`,
}))

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: { user: unknown }) => unknown) => selector({ user: null }),
}))

afterEach(() => {
  cleanup()
  setLang('ru')
})

beforeEach(() => {
  setLang('ru')
})

describe('публичный контур — язык', () => {
  it('лента по-русски: порядок сортировки и подписи', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FeedPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Публичные истории')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'По оценке' })).toBeTruthy()
    expect(screen.getByText(/Читать/)).toBeTruthy()
  })

  it('лента по-английски: сортировка, пустое описание и данные автора', async () => {
    setLang('en')
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <FeedPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Public stories')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'By rating' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'By views' })).toBeTruthy()
    // Данные истории: название и автор не переводятся, пустое описание — подпись словаря.
    expect(screen.getByText('Пролог')).toBeTruthy()
    expect(screen.getByText('Аня')).toBeTruthy()
    expect(screen.getByText('no description')).toBeTruthy()
    expect(screen.getAllByText(/Read/).length).toBeGreaterThan(0)
  })

  it('звёзды по-английски: доступные имена и подсказка без входа', () => {
    setLang('en')
    render(<RatingStars mine={null} avg={4.5} count={2} onRate={null} note={null} busy={false} />)
    expect(screen.getByRole('group', { name: 'Story rating' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Rate 3' }).length).toBe(1)
    expect(screen.getAllByTitle('Sign in to rate the story').length).toBe(5)
  })

  it('просмотрщик картинок по-английски: заголовок, навигация и подсказка', () => {
    setLang('en')
    render(
      <ImageViewer
        images={[{ id: 'a1', url: 'blob:a1', caption: 'Портрет' }]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next image' })).toBeTruthy()
    expect(screen.getByText(/swipe left-right/)).toBeTruthy()
    // Подпись картинки — данные.
    expect(screen.getByText('Портрет')).toBeTruthy()
  })
})
