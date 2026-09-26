import { useEffect, useState } from 'react'

/**
 * ScrubController — слушает window.scroll и нормализует позицию в [0..n-1].
 * n — количество «логических» шагов между событиями (smooth scrubbing).
 */
export function useScrub(sectionCount: number, separatorVh = 1.5) {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    function onScroll() {
      const vh = window.innerHeight
      const y = window.scrollY
      const total = Math.max(1, sectionCount - 1 + separatorVh) * vh
      const t = Math.max(0, Math.min(total, y))
      const local = (t / vh) - 0 // смещение
      // map local index (0 .. total/vh - separatorVh) → [0..n-1]
      const maxF = Math.max(0, sectionCount - 1)
      setIdx(Math.max(0, Math.min(maxF, local)))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [sectionCount, separatorVh])

  return idx
}
