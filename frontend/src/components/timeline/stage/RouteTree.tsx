import type { TimelineChapter } from '../timelineModel'

interface Props {
  chapters: TimelineChapter[]
  activeChapter: number
  activeFrame: number
  onChapter: (index: number) => void
  onFrame: (chapterIndex: number, frameIndex: number) => void
}

/**
 * Маршрут справа: читаемая навигация по главам и кадрам.
 *
 * Раньше это были одни точки с подписью, всплывающей только под курсором:
 * названия не читались, кегль был ~11px, длинные заголовки обрезались
 * многоточием. Теперь — карточка с постоянными подписями: номер главы
 * в отдельной колонке, название переносится на две строки, пройденные главы
 * и текущая обозначены состоянием рельсы, а у активной главы раскрыта ветка
 * кадров (глава → под-события → под-шаги).
 */
export function RouteTree({ chapters, activeChapter, activeFrame, onChapter, onFrame }: Props) {
  return (
    <nav className="sf-route" aria-label="Маршрут по главам">
      <p className="sf-route__head">Маршрут</p>
      <div className="sf-route__list">
        <span className="sf-route__rail" aria-hidden />
        {chapters.map((chapter, ci) => {
          const isActive = ci === activeChapter
          const state = isActive ? ' is-active' : ci < activeChapter ? ' is-passed' : ''
          return (
            <div className="sf-route__group" key={chapter.id}>
              <button
                type="button"
                className={'sf-route__row' + state}
                onClick={() => onChapter(ci)}
                aria-current={isActive ? 'true' : undefined}
                title={chapter.title || `Глава ${chapter.number}`}
              >
                <i className="sf-route__dot" aria-hidden />
                <span className="sf-route__num">{chapter.number}</span>
                <span className="sf-route__label">{chapter.title || `Глава ${chapter.number}`}</span>
              </button>

              {isActive && chapter.frames.length > 1 && (
                <div className="sf-route__branch">
                  {chapter.frames.map((frame, fi) => (
                    <button
                      key={frame.id}
                      type="button"
                      className={fi === activeFrame ? 'sf-route__row sf-route__row--sub is-active' : 'sf-route__row sf-route__row--sub'}
                      onClick={() => onFrame(ci, fi)}
                      aria-current={fi === activeFrame ? 'true' : undefined}
                      title={`${frame.number} ${fi === 0 ? 'глава' : frame.title}`}
                    >
                      <i className="sf-route__dot" aria-hidden />
                      <span className="sf-route__num">{frame.number}</span>
                      <span className="sf-route__label">{fi === 0 ? 'глава' : frame.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
