import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { getLang, setLang, toggleLang, useLang } from './lang'

/**
 * Язык интерфейса (0.115.0).
 *
 * Что закрепляем: русский по умолчанию, выбор запоминается в `localStorage`, `<html lang>`
 * обновляется (от него зависят переносы и озвучка) и подписанный компонент узнаёт о смене
 * БЕЗ перезагрузки — иначе переключатель в шапке менял бы только слово на кнопке.
 */
const KEY = 'skyfraze-lang'

function Probe() {
  const [lang] = useLang()
  return <span data-testid="lang">{lang}</span>
}

afterEach(() => {
  act(() => setLang('ru'))
  window.localStorage.removeItem(KEY)
})

describe('store/lang', () => {
  it('по умолчанию русский', () => {
    expect(getLang()).toBe('ru')
  })

  it('смена языка запоминается и меняет <html lang>', () => {
    setLang('en')
    expect(getLang()).toBe('en')
    expect(window.localStorage.getItem(KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('toggleLang переключает туда и обратно', () => {
    expect(toggleLang()).toBe('en')
    expect(toggleLang()).toBe('ru')
  })

  it('подписанный компонент узнаёт о смене без перезагрузки', () => {
    render(<Probe />)
    expect(screen.getByTestId('lang').textContent).toBe('ru')
    act(() => setLang('en'))
    expect(screen.getByTestId('lang').textContent).toBe('en')
    act(() => setLang('ru'))
    expect(screen.getByTestId('lang').textContent).toBe('ru')
  })
})
