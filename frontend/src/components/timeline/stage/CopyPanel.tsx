import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IMAGE_MIME_PREFIX,
  eventPosition,
  type TimelineChapter,
  type TimelineFrame,
} from '../timelineModel'
import { ImageViewer } from '../../ImageViewer'
import { MarkdownBlock } from '../../MarkdownBlock'
import { dateLabel } from '../../../collab/eventDate'
import { useT } from '../../../i18n'
import { highlightQuote } from '../../../lib/quoteHighlight'
import { SelectionMenu } from './SelectionMenu'

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
  /**
   * Файлы проекта (id → адрес), доступные странице: ссылки `/api/assets/<id>` в
   * тексте кадра заменяются на них — иначе картинка в тексте не открывается
   * (эндпоинт требует авторизации, а `<img>` заголовок не передаёт).
   */
  assetUrls?: Record<string, string>
  /**
   * Фразу подсветить (0.133.0). Приходит из чата (клик по ссылке на кадр у получателя) и из
   * редакторов («Показать в проекте»): человек должен увидеть то самое место, а не «где-то в этом
   * кадре». `nonce` нужен, чтобы повторная просьба о той же фразе сработала снова.
   */
  highlight?: { frameId: string; quote: string; nonce: number } | null
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
  chapter, frame, onJumpFrame, onPrev, onNext, prevLabel, nextLabel, footer, assetUrls,
  highlight,
}: Props) {
  const t = useT()
  const images = frame.assets.filter((a) => a.mime.startsWith(IMAGE_MIME_PREFIX))
  const [viewer, setViewer] = useState<number | null>(null)
  /** Фразу просили подсветить, но в этом кадре её уже нет (0.133.0). */
  const [missing, setMissing] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Просмотр закрывается при смене кадра: следующий кадр — уже другое событие.
  useEffect(() => setViewer(null), [frame.id])

  /**
   * Подсветка фразы, к которой пришли из чата или из редакторов (0.133.0).
   *
   * Подсветка снимается сама через несколько секунд и при смене кадра: это указатель «вот это
   * место», а не разметка текста. Если фразы в кадре уже нет (соавтор переписал абзац) — не
   * подсвечиваем первое похожее: говорим об этом плашкой, иначе человек решит, что обсуждали не
   * то.
   */
  useEffect(() => {
    const node = bodyRef.current
    if (!node || !highlight || highlight.frameId !== frame.id) return undefined
    const applied = highlightQuote(node, highlight.quote)
    setMissing(!applied.found)
    const timer = window.setTimeout(() => {
      applied.clear()
      setMissing(false)
    }, 8000)
    return () => {
      window.clearTimeout(timer)
      applied.clear()
    }
  }, [frame.body, frame.id, highlight?.frameId, highlight?.nonce, highlight?.quote])

  const isPhoto = frame.kind === 'image'
  const position = eventPosition(chapter.frames, frame)
  const photoIndex = frame.imageIndex ?? 0
  const photoCount = frame.imageCount ?? 1
  // Дата события — мета-чип в кадре (поле в редакторе так и подписано). Пустая
  // или непонятная дата чипа не создаёт: строка «дата: » хуже, чем её отсутствие.
  const dateText = dateLabel(frame.eventDate)
  const viewerImages = images.map((asset) => ({ id: asset.id, url: asset.url, caption: frame.title }))

  return (
    <div
      className={isPhoto ? 'sf-copy sf-copy--photo' : 'sf-copy'}
      key={frame.id}
      data-frame-id={frame.id}
      data-frame-number={frame.number}
      data-frame-kind={frame.kind}
    >
      {/* Содержимое кадра прокручивается внутри листа, а навигация и блок
          страницы (оценка, просмотры) остаются на виду: на телефоне до кнопок
          «назад/дальше» иначе приходилось докручивать. */}
      <div className="sf-copy__scroll">
        {isPhoto ? (
          <>
            <div className="sf-copy__num">
              {frame.ownerNumber ?? frame.number} ·{' '}
              {t('copy.photo', { index: photoIndex + 1, total: photoCount })}
            </div>
            <span className="sf-copy__eyebrow">{frame.eyebrow}</span>
            <h2 className="sf-copy__title sf-copy__title--photo">
              {frame.title || t('common.untitled')}
            </h2>
            <ul className="sf-copy__meta">
              <li>{t('copy.chapter', { number: chapter.number, title: chapter.title })}</li>
              {photoCount > 1 && <li>{t('copy.photosOfEvent', { count: photoCount })}</li>}
            </ul>
            <button type="button" className="sf-btn sf-btn--ghost" onClick={() => setViewer(photoIndex)}>
              {t('copy.openFull')}
            </button>
          </>
        ) : (
          <>
            <div className="sf-copy__num">
              {frame.number} · {position.index} / {position.total}
            </div>
            <span className="sf-copy__eyebrow">{frame.eyebrow}</span>
            <h2 className="sf-copy__title">{frame.title || t('common.untitled')}</h2>
            {frame.body && (
              <div
                className="sf-copy__body-wrap"
                data-frame-body={frame.id}
                data-frame-source={frame.body}
                ref={bodyRef}
              >
                <MarkdownBlock source={frame.body} className="sf-copy__body" assetUrls={assetUrls} />
              </div>
            )}
            {missing && highlight && (
              <p className="sf-copy__quote-note" data-quote-missing>
                {t('sel.showMissing', { quote: highlight.quote })}
              </p>
            )}

          <ul className="sf-copy__meta">
            {!frame.isChapter && (
              <li>{t('copy.chapter', { number: chapter.number, title: chapter.title })}</li>
            )}
            {frame.isChapter && (
              <li>
                {position.total > 1
                  ? t('copy.framesInChapter', { count: position.total })
                  : t('copy.noSubEvents')}
              </li>
            )}
            {dateText && <li>{t('copy.date', { date: dateText })}</li>}
            {images.length > 0 && <li>{t('copy.images', { count: images.length })}</li>}
          </ul>

          {images.length > 0 && (
            <div className="sf-copy__gallery" aria-label={t('copy.galleryAria')}>
              {images.map((asset, i) => (
                <button
                  key={asset.id}
                  type="button"
                  className="sf-copy__shot"
                  onClick={() => setViewer(i)}
                  title={t('copy.openFullTitle')}
                >
                  <img src={asset.url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}

          {frame.childFrames.length > 0 && (
            <ol className="sf-copy__next" aria-label={t('copy.childrenAria')}>
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
                      <span className="sf-copy__next-title">{child.title || t('common.untitled')}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
          </>
        )}
      </div>

      <div className="sf-copy__nav">
        <button type="button" className="sf-btn sf-btn--ghost" disabled={!onPrev} onClick={() => onPrev?.()}>
          ← {prevLabel ? t('copy.prevNamed', { label: prevLabel }) : t('copy.prev')}
        </button>
        <button type="button" className="sf-btn sf-btn--primary" disabled={!onNext} onClick={() => onNext?.()}>
          {nextLabel ? t('copy.nextNamed', { label: nextLabel }) : t('copy.end')}
        </button>
      </div>

      {frame.body && (
        <SelectionMenu frameId={frame.id} frameTitle={frame.title} source={frame.body} />
      )}

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
