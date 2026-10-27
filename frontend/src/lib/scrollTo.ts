/**
 * Прокрутка к элементу ВНУТРИ `main`, а не по документу (0.72.1).
 *
 * Почему не `element.scrollIntoView()`. Прокрутка живёт только во вложенном `.layout main`
 * (`html, body, #root { overflow: hidden }`), но `scrollIntoView` прокручивает ВСЕ
 * прокручиваемые предки, включая сам документ — даже при `overflow: hidden`, потому что запрет
 * касается пользователя, а не программной прокрутки. Документ сдвигался на высоту шапки, шапка
 * уезжала за экран, и вернуться сама уже не могла: пользователю прокрутка документа запрещена.
 * Именно так «полоска меню» пропадала при переходе к «Редакторам» и возвращалась только после
 * перезагрузки.
 *
 * Здесь мы считаем позицию относительно `main` и прокручиваем только его.
 */
export function scrollWithinMain(element: HTMLElement | null, offset = 8): void {
  if (!element) return
  const main = element.closest('main')
  if (!(main instanceof HTMLElement)) {
    // Вне `main` (теоретически) — ведём себя как раньше, но с ближайшим блоком.
    element.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  const top =
    element.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - offset
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth'
  main.scrollTo({ top: Math.max(0, top), behavior })
}

/** Уважаем системную настройку «меньше движения»: плавная прокрутка — не обязательна. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
