/**
 * Хелперы для работы с реальным скролл-контейнером.
 *
 * В приложении скроллится не window, а `<main>` из `.layout`
 * (`.layout main { overflow: auto; }`), поэтому любая логика, которая читает
 * `window.scrollY` / `window.innerHeight` или вешает слушатель на `window`,
 * молча не работает: window.scrollY всегда 0.
 *
 * Эти функции находят фактический scrollport и дают единые метрики для
 * таймлайна и 3D-сцены, независимо от того, window это или вложенный контейнер.
 */

function isViewport(root: HTMLElement | null): boolean {
  if (!root) return true
  const se = document.scrollingElement
  return root === se || root === document.documentElement || root === document.body
}

/** Ближайший скроллящийся предок (включая сам элемент), иначе — document.scrollingElement. */
export function getScrollRoot(from: Element | null): HTMLElement | null {
  let cur: Element | null = from
  while (cur) {
    if (cur instanceof HTMLElement) {
      const overflowY = getComputedStyle(cur).overflowY
      const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
      if (scrollable && cur.scrollHeight > cur.clientHeight + 1) return cur
    }
    cur = cur.parentElement
  }
  const se = document.scrollingElement
  return se instanceof HTMLElement ? se : null
}

/** Видимая область скролл-контейнера в координатах viewport. */
export function visibleBox(root: HTMLElement | null): { top: number; bottom: number } {
  if (isViewport(root)) return { top: 0, bottom: window.innerHeight }
  const r = root!.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom }
}

/** Текущее смещение скролла. */
export function scrollOffset(root: HTMLElement | null): number {
  return isViewport(root) ? window.scrollY : root!.scrollTop
}

/** Прогресс скролла 0..1 внутри контейнера. */
export function scrollProgress(root: HTMLElement | null): number {
  if (isViewport(root)) {
    const max = document.documentElement.scrollHeight - window.innerHeight
    return max > 0 ? Math.max(0, Math.min(1, window.scrollY / max)) : 0
  }
  const max = root!.scrollHeight - root!.clientHeight
  return max > 0 ? Math.max(0, Math.min(1, root!.scrollTop / max)) : 0
}

/**
 * Подписка на скролл ЛЮБОГО контейнера внутри документа.
 *
 * Событие `scroll` не всплывает, но проходит фазу перехвата (capture) от window
 * к цели, поэтому capture-слушатель на window ловит скролл и вложенного `<main>`,
 * и самого документа. Это позволяет не «прибиваться» к конкретному контейнеру:
 * раскладка может смениться (например, контент стал короче viewport) без потери
 * подписки.
 */
export function subscribeToAnyScroll(cb: () => void): () => void {
  window.addEventListener('scroll', cb, { passive: true, capture: true })
  window.addEventListener('resize', cb)
  window.addEventListener('orientationchange', cb)
  return () => {
    window.removeEventListener('scroll', cb, { capture: true })
    window.removeEventListener('resize', cb)
    window.removeEventListener('orientationchange', cb)
  }
}

/** Пользователь просил меньше анимации — программные прыжки тоже без smooth. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
