import { useEffect, useState, type ReactNode } from 'react'
import type { TimelineChapter, TimelineFrame } from '../timelineModel'

interface Props {
  chapter: TimelineChapter
  frame: TimelineFrame
  frameIndex: number
  onJumpFrame: (chapterIndex: number, frameIndex: number) => void
  /** Предыдущий/следующий кадр по всему таймлайну (переходят и через главы). */
  onPrev?: () => void
  onNext?: () => void
  prevLabel?: string
  nextLabel?: string
  /**
   * Дополнительный блок под навигацией. Нужен публичной странице: автор,
   * просмотры и оценка истории живут здесь, а не отдельным fixed-слоем —
   * иначе на узких экранах он перекрывает текст кадра.
   */
  footer?: ReactNode
}

/**
 * Копирайт активного кадра: нумерация, eyebrow, заголовок, текст, мета-чипы,
 * галерея картинок события (с просмотром в полный размер) и превью вложенных.
 *
 * Только просмотр и навигация: редактирование живёт в отдельном модуле
 * (components/editors), стадия с ним не связана.
 */
export function CopyPanel({
  chapter, frame, frameIndex, onJumpFrame, onPrev, onNext, prevLabel, nextLabel, footer,
}: Props) {
  const images = frame.assets.filter((a) => a.mime.startsWith('image/'))
  const [lightbox, setLightbox] = useState<string | null>(null)

  // Esc закрывает просмотр; при смене кадра просмотр сбрасывается.
  useEffect(() => setLightbox(null), [frame.id])
  useEffect(() => {
    if (!lightbox) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  return (
    <div className="sf-copy" key={frame.id} data-frame-id={frame.id} data-frame-number={frame.number}>
      <div className="sf-copy__num">
        {frame.number} · {frameIndex + 1} / {chapter.frames.length}
      </div>
      <span className="sf-copy__eyebrow">{frame.eyebrow}</span>
      <h2 className="sf-copy__title">{frame.title || 'Без названия'}</h2>
      {frame.body && <p className="sf-copy__body">{frame.body}</p>}

      <ul className="sf-copy__meta">
        {!frame.isChapter && <li>глава {chapter.number}: {chapter.title}</li>}
        {frame.isChapter && (
          <li>{chapter.frames.length > 1 ? `кадров в главе: ${chapter.frames.length}` : 'без под-событий'}</li>
        )}
        {images.length > 0 && <li>картинок: {images.length}</li>}
      </ul>

      {images.length > 0 && (
        <div className="sf-copy__gallery" aria-label="Картинки события">
          {images.slice(0, 6).map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="sf-copy__shot"
              onClick={() => setLightbox(asset.url)}
              title="Открыть в полный размер"
            >
              <img src={asset.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {frame.childFrames.length > 0 && (
        <ol className="sf-copy__next" aria-label="Вложенные события">
          {frame.childFrames.map((child, i) => (
            <li key={child.id}>
              <button
                type="button"
                className="sf-copy__next-row"
                onClick={() => onJumpFrame(chapter.chapterIndex, frameIndex + 1 + i)}
              >
                <span className="sf-copy__next-num">{child.number}</span>
                <span className="sf-copy__next-title">{child.title || 'Без названия'}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="sf-copy__nav">
        <button type="button" className="sf-btn sf-btn--ghost" disabled={!onPrev} onClick={() => onPrev?.()}>
          ← {prevLabel ? `назад: ${prevLabel}` : 'назад'}
        </button>
        <button type="button" className="sf-btn sf-btn--primary" disabled={!onNext} onClick={() => onNext?.()}>
          {nextLabel ? `дальше: ${nextLabel} →` : 'конец таймлайна'}
        </button>
      </div>

      {footer && <div className="sf-copy__footer">{footer}</div>}

      {lightbox && (
        <div
          className="sf-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Просмотр картинки"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="" />
          <button type="button" className="sf-lightbox__close" onClick={() => setLightbox(null)}>
            закрыть ✕
          </button>
        </div>
      )}
    </div>
  )
}
