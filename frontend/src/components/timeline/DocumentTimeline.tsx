import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MarkdownBlock } from '../MarkdownBlock'
import { ImageViewer, type ViewerImage } from '../ImageViewer'
import { BrandMark } from '../BrandMark'
import { ChapterChips } from './stage/ChapterChips'
import { getScrollRoot, prefersReducedMotion, subscribeToAnyScroll, visibleBox } from './scrollRoot'
import {
  IMAGE_MIME_PREFIX,
  eventFrames,
  eventPosition,
  type TimelineChapter,
  type TimelineFrame,
} from './timelineModel'

interface Props {
  chapters: TimelineChapter[]
  projectTitle?: string
  /** Кнопки страницы в шапке документа. */
  actions?: ReactNode
  /** Блок в конце истории (на публичной странице — автор, просмотры, оценка). */
  copyFooter?: ReactNode
}

/**
 * Мобильный таймлайн — обычный документ, а не сцена.
 *
 * На телефоне сценическая композиция (фиксированная сцена + лист копирайта)
 * заставляет держать текст и картинку в одном экране: приходится ужимать лист,
 * заводить отдельные прокрутки для текста и для картинки, а общий скролл при
 * этом не работает — палец над текстом крутит текст, а не историю.
 *
 * Здесь всё наоборот: кадры идут друг за другом в потоке — текст главы, её
 * картинки, текст под-события, его картинки, следующая глава. Скролл один,
 * общий, и ничего не перекрывается. Переключатель событий остаётся наверху
 * (липнет под шапкой) и прокручивает к нужному месту.
 */
export function DocumentTimeline({ chapters, projectTitle, actions, copyFooter }: Props) {
  const [active, setActive] = useState({ chapter: 0, frame: 0 })
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number; title: string } | null>(null)
  const blocks = useRef(new Map<string, HTMLElement>())

  const flat = useMemo(
    () =>
      chapters.flatMap((chapter) =>
        chapter.frames.map((frame, frameIndex) => ({ frame, chapter, frameIndex })),
      ),
    [chapters],
  )

  // Акцент активной главы: он красит активный чип и ссылки документа. Без него
  // `var(--sf-accent)` не определён, фон чипа не подставлялся, и текст сливался
  // с подложкой (аудит честно показал контраст 1:1).
  const accent = chapters[active.chapter]?.accent ?? chapters[0]?.accent

  /** Текущий кадр — последний, чей верх поднялся выше трети экрана. */
  useEffect(() => {
    const pick = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-doc-frame]'))
      if (nodes.length === 0) return
      const line = window.innerHeight * 0.35
      let best = nodes[0]
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= line) best = node
      }
      const next = {
        chapter: Number(best.dataset.docChapter ?? 0),
        frame: Number(best.dataset.docFrame ?? 0),
      }
      setActive((prev) => (prev.chapter === next.chapter && prev.frame === next.frame ? prev : next))
    }
    pick()
    return subscribeToAnyScroll(pick)
  }, [chapters])

  const jumpTo = useCallback((chapterIndex: number, frameIndex: number) => {
    const node = blocks.current.get(`${chapterIndex}:${frameIndex}`)
    if (!node) return
    // Прокручиваем САМ документ, а не «scrollIntoView»: тот двигает все
    // прокручиваемые предки, включая полосу чипов, и она съезжала по горизонтали.
    // Сверху оставляем место под липкую полосу, иначе она закрывает заголовок.
    const sticky = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--sf-chips-h'),
    ) || 0
    const root = getScrollRoot(node)
    const box = visibleBox(root)
    const delta = node.getBoundingClientRect().top - box.top - sticky - 8
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
    if (root && root !== document.scrollingElement) {
      root.scrollTo({ top: root.scrollTop + delta, behavior })
    } else {
      window.scrollTo({ top: window.scrollY + delta, behavior })
    }
  }, [])

  const openViewer = useCallback((frame: TimelineFrame) => {
    const images = frame.assets.filter((a) => a.mime.startsWith(IMAGE_MIME_PREFIX))
    if (images.length === 0) return
    const index = frame.kind === 'image' ? images.findIndex((a) => a.id === frame.image?.id) : 0
    setViewer({
      images: images.map((a) => ({ id: a.id, url: a.url, caption: frame.title })),
      index: index < 0 ? 0 : index,
      title: frame.title,
    })
  }, [])

  return (
    <div
      className="sf-root sf-root--doc sf-doc"
      data-stage="document"
      data-doc
      style={{ ['--sf-accent' as string]: accent }}
    >
      <header className="sf-doc__head">
        <span className="sf-doc__title">
          <BrandMark size={22} className="sf-doc__mark" />
          <span className="sf-doc__name">{projectTitle ?? 'Таймлайн'}</span>
        </span>
        {actions && <div className="sf-doc__actions">{actions}</div>}
      </header>

      <div className="sf-doc__chips">
        <ChapterChips
          chapters={chapters}
          activeChapter={active.chapter}
          activeFrame={active.frame}
          onChapter={(ci) => jumpTo(ci, 0)}
          onFrame={jumpTo}
        />
      </div>

      <div className="sf-doc__body">
        {flat.map(({ frame, chapter, frameIndex }) => {
          const key = `${chapter.chapterIndex}:${frameIndex}`
          const register = (el: HTMLElement | null) => {
            if (el) blocks.current.set(key, el)
            else blocks.current.delete(key)
          }
          return frame.kind === 'image' ? (
            <DocImage
              key={frame.id}
              frame={frame}
              register={register}
              chapterIndex={chapter.chapterIndex}
              frameIndex={frameIndex}
              onOpen={() => openViewer(frame)}
            />
          ) : (
            <DocEvent
              key={frame.id}
              frame={frame}
              chapter={chapter}
              register={register}
              chapterIndex={chapter.chapterIndex}
              frameIndex={frameIndex}
              onOpenImage={() => openViewer(frame)}
              onJump={jumpTo}
            />
          )
        })}

        {copyFooter && <div className="sf-doc__footer">{copyFooter}</div>}
      </div>

      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onIndexChange={(index) => setViewer((prev) => (prev ? { ...prev, index } : prev))}
          onClose={() => setViewer(null)}
          title={viewer.title}
        />
      )}
    </div>
  )
}

interface BlockProps {
  frame: TimelineFrame
  register: (el: HTMLElement | null) => void
  chapterIndex: number
  frameIndex: number
}

/** Кадр события: номер, надзаголовок, заголовок, текст (markdown) и мета-чипы. */
function DocEvent({
  frame, chapter, register, chapterIndex, frameIndex, onOpenImage, onJump,
}: BlockProps & { chapter: TimelineChapter; onOpenImage: () => void; onJump: (chapterIndex: number, frameIndex: number) => void }) {
  const images = frame.assets.filter((a) => a.mime.startsWith(IMAGE_MIME_PREFIX))
  const position = eventPosition(chapter.frames, frame)
  return (
    <article
      className="sf-doc__event"
      ref={register}
      data-doc-frame
      data-doc-chapter={chapterIndex}
      data-doc-frame-index={frameIndex}
      data-frame-number={frame.number}
      data-frame-kind="event"
    >
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

      {/* Миниатюры нужны только чтобы открыть просмотр: сами картинки идут
          следующими блоками, дублировать их полотном здесь незачем. */}
      {images.length > 0 && (
        <div className="sf-copy__gallery" aria-label="Картинки события">
          {images.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="sf-copy__shot"
              onClick={onOpenImage}
              title="Открыть в полном размере"
            >
              <img src={asset.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {frame.childFrames.length > 0 && (
        <ol className="sf-copy__next" aria-label="Вложенные события">
          {frame.childFrames.map((child) => {
            const target = chapter.frames.findIndex((f) => f.id === child.id)
            return (
              <li key={child.id}>
                <button
                  type="button"
                  className="sf-copy__next-row"
                  onClick={() => target >= 0 && onJump(chapterIndex, target)}
                >
                  <span className="sf-copy__next-num">{child.number}</span>
                  <span className="sf-copy__next-title">{child.title || 'Без названия'}</span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </article>
  )
}

/** Кадр-картинка: сама картинка во всю ширину, подпись и открытие в полный размер. */
function DocImage({ frame, register, chapterIndex, frameIndex, onOpen }: BlockProps & { onOpen: () => void }) {
  const image = frame.image
  if (!image) return null
  const number = frame.ownerNumber ?? frame.number
  return (
    <figure
      className="sf-doc__image"
      ref={register}
      data-doc-frame
      data-doc-chapter={chapterIndex}
      data-doc-frame-index={frameIndex}
      data-frame-number={frame.number}
      data-frame-kind="image"
    >
      <button type="button" className="sf-doc__shot" onClick={onOpen} title="Открыть в полном размере">
        <img src={image.url} alt="" loading="lazy" />
      </button>
      <figcaption className="sf-copy__num">
        {number} · фото {(frame.imageIndex ?? 0) + 1} / {frame.imageCount ?? 1}
        {frame.title ? ` — ${frame.title}` : ''}
      </figcaption>
    </figure>
  )
}

/** Сколько всего кадров-событий в документе — для тестов и отладки. */
export function documentEventCount(chapters: TimelineChapter[]): number {
  return chapters.reduce((sum, chapter) => sum + eventFrames(chapter.frames).length, 0)
}
