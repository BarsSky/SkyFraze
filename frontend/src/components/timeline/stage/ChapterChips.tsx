import type { TimelineChapter } from '../timelineModel'

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
 */
export function ChapterChips({ chapters, activeChapter, activeFrame, onChapter, onFrame }: Props) {
  const chapter = chapters[activeChapter]
  return (
    <div className="sf-chips" role="navigation" aria-label="Главы и под-события">
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
      {chapter?.frames.slice(1).map((frame, i) => (
        <button
          key={frame.id}
          type="button"
          className={i + 1 === activeFrame ? 'sf-chip sf-chip--sub is-active' : 'sf-chip sf-chip--sub'}
          onClick={() => onFrame(activeChapter, i + 1)}
          title={frame.title}
        >
          {frame.number}
        </button>
      ))}
    </div>
  )
}
