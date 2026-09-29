import { useEffect, useState } from 'react'

/**
 * Подписка на медиазапрос из React.
 *
 * Нужна там, где раскладка меняется не только стилями: на телефоне таймлайн —
 * это обычный документ (текст, картинки, следующее событие), а на широком
 * экране — сценическая композиция с фиксированными слоями и скроллом-таймлайном.
 * Одними media query в CSS такую разницу не выразить: разный DOM.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const list = window.matchMedia(query)
    const apply = () => setMatches(list.matches)
    apply()
    list.addEventListener('change', apply)
    return () => list.removeEventListener('change', apply)
  }, [query])

  return matches
}
