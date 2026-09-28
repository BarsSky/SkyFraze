import { useEffect, useState, type ReactNode } from 'react'
import {
  IMAGE_MIME_PREFIX,
  eventPosition,
  type TimelineChapter,
  type TimelineFrame,
} from '../timelineModel'
import { ImageViewer } from '../../ImageViewer'
import { MarkdownBlock } from '../../MarkdownBlock'

interface Props {
  chapter: TimelineChapter
  frame: TimelineFrame
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
 * галерея картинок события и превью вложенных.
 *
 * Кадры бывают двух видов. Кадр события показывает текст и миниатюры вложений:
 * клик по миниатюре открывает полноэкранный просмотрщик со свайпом. Кадр-картинка
 * (kind === 'image') — это сама фотография во весь экран с короткой подписью;
 * такие кадры идут друг за другом до под-событий, поэтому при прокрутке
 * вложенные картинки события показываются по очереди.
 *
 * Только просмотр и навигация: редактирование живёт в отдельном модуле
 * (components/editors), стадия с ним не связана.
 */
export function CopyPanel({
  chapter, frame, onJumpFrame, onPrev, onNext, prevLabel, nextLabel, footer,
}: Props) {
  const images = frame.assets.filter((a) => a.mime.startsWith(IMAGE_MIME_PREFIX))
  const [viewer, setViewer] = useState<number | null>(null)

  // Просмотр закрывается при смене кадра: следующий кадр — уже другое событие.
  useEffect(() => setViewer(null), [frame.id])

  const isPhoto = frame.kind === 'image'
  const position = eventPosition(chapter.frames, frame)
  const photoIndex = frame.imageIndex ?? 0
  const photoCount = frame.imageCount ?? 1
  const viewerImages = images.map((asset) => ({ id: asset.id, url: asset.url, caption: frame.title }))

  return (
    <div
      className={isPhoto ? 'sf-copy sf-copy--photo' : 'sf-copy'}
      key={frame.id}
      data-frame-id={frame.id}
      data-frame-number={frame.number}
      data-frame-kind={frame.kind}
    >
      {isPhoto ? (
        <>
          <div className="sf-copy__num">
            {frame.ownerNumber ?? frame.number} · фото {photoIndex + 1} / {photoCount}
          </div>
          <span className="sf-copy__eyebrow">{frame.eyebrow}</span>
          <h2 className="sf-copy__title sf-copy__title--photo">{frame.title || 'Без названия'}</h2>
          <ul className="sf-copy__meta">
            <li>глава {chapter.number}: {chapter.title}</li>
            {photoCount > 1 && <li>картинок у события: {photoCount}</li>}
          </ul>
          <button type="button" className="sf-btn sf-btn--ghost" onClick={() => setViewer(photoIndex)}>
            открыть в полный размер
          </button>
        </>
      ) : (
        <>
          <div className="sf-copy__num">
            {frame.number} · {position.index} / {position.total}
          </div>
          <span className="sf-copy__eyebrow">{frame.eyebrow}</span>
          <h2 className="sf-copy__title">{frame.title || 'Без названия'}</h2>
          {frame.body && <MarkdownBlock source={frame.body} className="sf-copy__body" />}

          <ul className="sf-copy__meta">
            {!frame.isChapter && <li>глава {chapter.number}: {chapter.title}</li>}
            {frame.isChapter && (
              <li>{position.total > 1 ? `кадров в главе: ${position.total}` : 'без под-событий'}</li>
            )}
            {images.length > 0 && <li>картинок: {images.length}</li>}
          </ul>

          {images.length > 0 && (
            <div className="sf-copy__gallery" aria-label="Картинки события">
              {images.map((asset, i) => (
                <button
                  key={asset.id}
                  type="button"
                  className="sf-copy__shot"
                  onClick={() => setViewer(i)}
                  title="Открыть в полный размер"
                >
                  <img src={asset.url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}

          {frame.childFrames.length > 0 && (
            <ol className="sf-copy__next" aria-label="Вложенные события">
              {frame.childFrames.map((child) => {
                const childIndex = chapter.frames.findIndex((f) => f.id === child.id)
                return (
                  <li key={child.id}>
                    <button
                      type="button"
                      className="sf-copy__next-row"
                      onClick={() => childIndex >= 0 && onJumpFrame(chapter.chapterIndex, childIndex)}
                    >
                      <span className="sf-copy__next-num">{child.number}</span>
                      <span className="sf-copy__next-title">{child.title || 'Без названия'}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </>
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

      {viewer !== null && viewerImages.length > 0 && (
        <ImageViewer
          images={viewerImages}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          title={frame.title}
        />
      )}
    </div>
  )
}
