import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

export interface ViewerImage {
  id: string
  url: string
  caption?: string
}

interface Props {
  images: ViewerImage[]
  /** Индекс показанной картинки; управляется снаружи, чтобы галерея и кадр не расходились. */
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
  /** Заголовок события — подпись под картинкой и имя окна для скринридера. */
  title?: string
}

/** Порог свайпа: либо 48px, либо 14% ширины экрана — что больше (палец на телефоне). */
function swipeThreshold(): number {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth
  return Math.max(48, width * 0.14)
}

/**
 * Полноэкранный просмотр картинок события.
 *
 * Отдельный слой поверх всего сайта (портал в body, потому что панель копирайта
 * прокручивается и обрезала бы вложенное окно): свайп влево/вправо, стрелки,
 * счётчик «2 / 5», закрытие по Esc, клику по фону или кнопке.
 */
export function ImageViewer({ images, index, onIndexChange, onClose, title }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number; pointerId: number; swiped: boolean } | null>(null)
  const movedRef = useRef(false)
  const [drag, setDrag] = useState(0)

  const total = images.length
  const current = Math.max(0, Math.min(total - 1, index))
  const clampIndex = useCallback((next: number) => Math.max(0, Math.min(total - 1, next)), [total])
  const go = useCallback((delta: number) => onIndexChange(clampIndex(index + delta)), [clampIndex, index, onIndexChange])

  // Индекс мог выйти за границы (набор картинок изменился) — подтягиваем его.
  useEffect(() => {
    if (total > 0 && index !== current) onIndexChange(current)
  }, [current, index, onIndexChange, total])

  // Фокус уходит в окно просмотра, фон перестаёт прокручиваться; при закрытии
  // возвращаем и фокус, и прокрутку.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.documentElement.classList.add('sf-viewer-open')
    dialogRef.current?.focus()
    return () => {
      document.documentElement.classList.remove('sf-viewer-open')
      restoreFocusRef.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        go(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        go(1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        onIndexChange(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        onIndexChange(total - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose, onIndexChange, total])

  // Соседние картинки прогреваем заранее: свайп не должен ждать загрузку.
  useEffect(() => {
    if (typeof Image === 'undefined') return
    for (const neighbour of [current - 1, current + 1]) {
      const item = images[neighbour]
      if (item) new Image().src = item.url
    }
  }, [current, images])

  useEffect(() => setDrag(0), [current])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Кнопки и другие элементы управления не участвуют в свайпе.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    movedRef.current = false
    dragStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, swiped: false }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start || start.pointerId !== e.pointerId) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    // Вертикальный жест (прокрутка страницы) свайпом не считается.
    if (Math.abs(dy) > Math.abs(dx)) return
    if (!start.swiped && Math.abs(dx) < 8) return
    start.swiped = true
    movedRef.current = true
    setDrag(dx)
  }

  const endSwipe = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start || start.pointerId !== e.pointerId) return
    dragStartRef.current = null
    const dx = e.clientX - start.x
    setDrag(0)
    if (Math.abs(dx) >= swipeThreshold()) go(dx < 0 ? 1 : -1)
  }

  if (total === 0) return null
  const image = images[current]
  const caption = image.caption ?? title

  return createPortal(
    <div
      className="sf-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `Просмотр картинок: ${title}` : 'Просмотр картинок'}
      ref={dialogRef}
      tabIndex={-1}
      data-viewer-index={current}
      data-viewer-total={total}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endSwipe}
      onPointerCancel={endSwipe}
      onClick={(e) => {
        // Клик по фону закрывает; клик после свайпа — не закрывает.
        if (e.target === e.currentTarget && !movedRef.current) onClose()
      }}
    >
      <div className="sf-viewer__bar">
        <span className="sf-viewer__count" aria-live="polite">
          {current + 1} / {total}
        </span>
        <button type="button" className="sf-viewer__close" onClick={onClose} aria-label="Закрыть просмотр">
          закрыть ✕
        </button>
      </div>

      <div className="sf-viewer__body">
        <button
          type="button"
          className="sf-viewer__nav sf-viewer__nav--prev"
          onClick={() => go(-1)}
          disabled={current === 0}
          aria-label="Предыдущая картинка"
        >
          ‹
        </button>

        <img
          className="sf-viewer__img"
          src={image.url}
          alt={caption ?? ''}
          draggable={false}
          style={drag ? { transform: `translateX(${drag}px)` } : undefined}
        />

        <button
          type="button"
          className="sf-viewer__nav sf-viewer__nav--next"
          onClick={() => go(1)}
          disabled={current === total - 1}
          aria-label="Следующая картинка"
        >
          ›
        </button>
      </div>

      {caption && <p className="sf-viewer__caption">{caption}</p>}
      <p className="sf-viewer__hint">свайп влево-вправо, стрелки ← → или Esc — закрыть</p>
    </div>,
    document.body,
  )
}
