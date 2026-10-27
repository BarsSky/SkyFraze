import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollWithinMain } from './scrollTo'

/**
 * Прокрутка к элементу внутри `main` (0.72.1).
 *
 * Тест закрепляет главное: прокручивается ТОЛЬКО `main`, а документ не трогается. Именно
 * `scrollIntoView` двигал документ (при `overflow: hidden` программная прокрутка всё равно
 * работает), шапка уезжала за экран и не возвращалась — человек видел «меню пропало».
 */

function build() {
  document.body.innerHTML = `
    <div class="layout">
      <header>шапка</header>
      <main><section id="target">панель</section></main>
    </div>
  `
  const main = document.querySelector('main') as HTMLElement & { scrollTo?: unknown }
  const target = document.getElementById('target') as HTMLElement
  // jsdom не считает раскладку: подставляем геометрию, как у настоящей страницы.
  main.getBoundingClientRect = () => ({ top: 62, bottom: 900, left: 0, right: 1280 }) as DOMRect
  target.getBoundingClientRect = () => ({ top: 700, bottom: 1200, left: 0, right: 1280 }) as DOMRect
  main.scrollTop = 100
  const scrollTo = vi.fn()
  main.scrollTo = scrollTo as unknown as typeof main.scrollTo
  return { main, target, scrollTo }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('scrollWithinMain', () => {
  it('прокручивает main на позицию элемента, документ не трогает', () => {
    const { main, target, scrollTo } = build()
    scrollWithinMain(target)
    // top элемента (700) − top main (62) + текущая прокрутка main (100) − отступ 8.
    expect(scrollTo).toHaveBeenCalledWith({ top: 730, behavior: expect.any(String) })
    expect(document.documentElement.scrollTop).toBe(0)
    expect(document.body.scrollTop).toBe(0)
    expect(main.scrollTop).toBe(100)
  })

  it('не уводит прокрутку в минус: блок выше начала списка остаётся в начале', () => {
    const { main, target, scrollTo } = build()
    main.scrollTop = 0
    target.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 0 }) as DOMRect
    scrollWithinMain(target)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: expect.any(String) })
  })

  it('null — тихий выход: кнопка могла нажать раньше, чем панель появилась', () => {
    expect(() => scrollWithinMain(null)).not.toThrow()
  })
})
