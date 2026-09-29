import { useEffect, useRef } from 'react'
import { eventFrames, type TimelineChapter } from '../timelineModel'

interface Props {
  chapters: TimelineChapter[]
  activeChapter: number
  activeFrame: number
  onChapter: (index: number) => void
  onFrame: (chapterIndex: number, frameIndex: number) => void
}

/**
 * Навигация для узких экранов: горизонтальные чипы — главы, затем кадры
 * активной главы (под-события). Заменяет вертикальный маршрут на ≤1280px.
 *
 * Кадры-картинки в чипы не попадают: это иллюстрации события, а не шаги.
 * Активный чип подкручивается в видимую часть полосы: она прокручивается по
 * горизонтали, и при переходе к следующей главе чип иначе остаётся за краем.
 */
export function ChapterChips({ chapters, activeChapter, activeFrame, onChapter, onFrame }: Props) {
  const chapter = chapters[activeChapter]
  const events = chapter ? eventFrames(chapter.frames) : []
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLElement>('.sf-chip.is-active')
    if (!active) return
    // block: 'nearest' — подкрутка чипа не должна двигать страницу по вертикали.
    try {
      active.scrollIntoView({ inline: 'center', block: 'nearest' })
    } catch {
      /* старые браузеры без объекта настроек — не критично */
    }
  }, [activeChapter, activeFrame])

  return (
    <div className="sf-chips" role="navigation" aria-label="Главы и под-события" ref={listRef}>
      {chapters.map((ch, ci) => (
        <button
          key={ch.id}
          type="button"
          className={ci === activeChapter ? 'sf-chip is-active' : 'sf-chip'}
          onClick={() => onChapter(ci)}
        >
          {ch.number} {ch.title || 'Без названия'}
        </button>
      ))}
      {chapter && events.slice(1).map((frame) => {
        const fi = chapter.frames.indexOf(frame)
        return (
          <button
            key={frame.id}
            type="button"
            className={fi === activeFrame ? 'sf-chip sf-chip--sub is-active' : 'sf-chip sf-chip--sub'}
            onClick={() => onFrame(activeChapter, fi)}
            title={frame.title}
          >
            {frame.number}
          </button>
        )
      })}
    </div>
  )
}
