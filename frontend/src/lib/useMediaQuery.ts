import { useCallback, useEffect, useState } from 'react'

/**
 * Подписка на медиа-запрос (0.78.0).
 *
 * Зачем хук, а не CSS: решение «показать пункт в строке или убрать в меню» — это не стили, а
 * РАЗНАЯ разметка. Ссылка, спрятанная за `overflow: hidden`, остаётся недоступной с клавиатуры и
 * невидимой глазом; ссылка в меню — доступна.
 *
 * В jsdom `matchMedia` может отсутствовать: тогда считаем, что запрос НЕ совпадает (широкий
 * экран) — разметка остаётся прежней, и тесты не падают из-за окружения.
 */
export function useMediaQuery(query: string): boolean {
  const read = useCallback((): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  }, [query])

  const [matches, setMatches] = useState(read)

  useEffect(() => {
    setMatches(read())
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    // Safari до 14 знал только addListener: без этого поворот телефона не перестраивал шапку.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [query, read])

  return matches
}
