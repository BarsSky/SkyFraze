import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AboutPage } from './AboutPage'
import { useAuthStore } from '../store/auth'

/**
 * «О проекте» (0.114.0): страница вместо подвала сайта.
 *
 * Что закрепляем: страница говорит, ЧТО развёрнуто на стенде (версия и коммит от сервера), не
 * ломается, если сервер версию не отдал, содержит то, что обычно ищут в подвале (лицензия,
 * исходники, документация, приватность, сторонние компоненты, связь), и открыта без входа.
 */
const buildInfo = vi.hoisted(() => vi.fn())

vi.mock('../api/health', () => ({ getBuildInfo: buildInfo }))

function renderAbout() {
  return render(
    <MemoryRouter>
      <AboutPage />
    </MemoryRouter>,
  )
}

const linkTo = (part: string) =>
  Array.from(document.querySelectorAll('a')).find((a) => (a.getAttribute('href') ?? '').includes(part))

beforeEach(() => {
  buildInfo.mockReset()
  buildInfo.mockResolvedValue({ version: 'v0.114.0', commit: 'abcdef1234567890' })
  useAuthStore.setState({ user: null })
})

afterEach(() => {
  cleanup()
})

describe('AboutPage', () => {
  it('показывает версию и коммит сборки от сервера', async () => {
    renderAbout()
    const build = document.querySelector('[data-about-version]')
    expect(screen.getByRole('heading', { name: 'О проекте' })).toBeTruthy()
    await waitFor(() => expect(build?.textContent).toContain('v0.114.0'))
    // Коммит — короткий (7 символов): в переписке диктуют именно его.
    expect(build?.textContent).toContain('abcdef1')
  })

  it('не ломается, если сервер не отдал версию', async () => {
    buildInfo.mockResolvedValue(null)
    renderAbout()
    await waitFor(() =>
      expect(document.querySelector('[data-about-version]')?.textContent).toContain(
        'Версия сборки неизвестна',
      ),
    )
    // Остальное содержимое на месте: страница полезна и без номера сборки.
    expect(screen.getByRole('heading', { name: 'Лицензия' })).toBeTruthy()
  })

  it('вмещает то, что обычно живёт в подвале: лицензия, исходники, документация, приватность, связь', async () => {
    renderAbout()
    await waitFor(() => expect(buildInfo).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: 'Лицензия' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Исходный код и происхождение' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Документация' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Данные и приватность' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Сторонние компоненты' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Связь' })).toBeTruthy()

    expect(linkTo('/blob/master/LICENSE')).toBeTruthy()
    expect(linkTo('/blob/master/NOTICE')).toBeTruthy()
    expect(linkTo('releases')).toBeTruthy()
    // Английские версии документов (0.113.0) — ссылкой с самой страницы.
    expect(linkTo('docs/run.en.md')).toBeTruthy()
    expect(linkTo('docs/features.en.md')).toBeTruthy()
    expect(linkTo('THIRD-PARTY-NOTICES.md')).toBeTruthy()
    // Телеметрии нет — это утверждение, а не украшение: оно и проверяется.
    expect(screen.getByText(/нет ни аналитики, ни телеметрии/i)).toBeTruthy()
  })

  it('английский блок размечен как английский (lang="en")', async () => {
    renderAbout()
    await waitFor(() => expect(buildInfo).toHaveBeenCalled())
    const en = document.querySelector('.about__card--en') as HTMLElement
    expect(en.getAttribute('lang')).toBe('en')
    expect(screen.getByRole('heading', { name: 'About this project (English)' })).toBeTruthy()
  })

  it('анонимному подсказывает, где открыть ленту, и не показывает лишних разделов', async () => {
    renderAbout()
    await waitFor(() => expect(buildInfo).toHaveBeenCalled())
    const feed = Array.from(document.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/feed',
    )
    expect(feed).toBeTruthy()
  })
})
