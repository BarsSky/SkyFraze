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
 * Навигация для узких экранов: ДВЕ полосы чипов — главы сверху, под-события активной главы
 * снизу (0.88.0). Заменяет вертикальный маршрут на ≤1280 px.
 *
 * Почему две полосы, а не одна. Отчёт: «элемент переключения по главам и подсобытиям
 * располагает сначала все главы, а потом подсобытия главы в одну строку — от чего неудобно
 * ориентироваться». В одной строке главы и шаги шли подряд: «01 … 10, 01.1, 01.2…», и было
 * непонятно, где кончаются главы и начинаются шаги. Теперь верхняя полоса — только главы,
 * нижняя — под-события текущей главы; глубина шага видна по номеру («02.1.1») и размеру чипа.
 *
 * Полоса тянется вниз, а не вбок: высоту стадия измеряет в `--sf-chips-h`, поэтому сцена,
 * панель и лист кадра сдвигаются ниже сами — дерево как бы «раскрывается вниз».
 *
 * Кадры-картинки в чипы не попадают: это иллюстрации события, а не шаги. Активный чип
 * подкручивается в видимую часть СВОЕЙ полосы: полосы прокручиваются по горизонтали, и иначе
 * при переходе к следующей главе чип остаётся за краем.
 */
export function ChapterChips({ chapters, activeChapter, activeFrame, onChapter, onFrame }: Props) {
  const chapter = chapters[activeChapter]
  const steps = chapter ? eventFrames(chapter.frames).slice(1) : []
  const chaptersRef = useRef<HTMLDivElement>(null)
  const stepsRef = useRef<HTMLDivElement>(null)

  /** Подкрутить активный чип в его полосе (block: 'nearest' не двигает страницу по вертикали). */
  const center = (list: HTMLDivElement | null) => {
    if (!list) return
    const active = list.querySelector<HTMLElement>('.sf-chip.is-active')
    if (!active) return
    try {
      active.scrollIntoView({ inline: 'center', block: 'nearest' })
    } catch {
      /* старые браузеры без объекта настроек — не критично */
    }
  }

  useEffect(() => center(chaptersRef.current), [activeChapter])
  useEffect(() => center(stepsRef.current), [activeChapter, activeFrame])

  return (
    <div className="sf-chips" role="navigation" aria-label="Главы и под-события">
      <div className="sf-chips__row" data-chips-row="chapters" ref={chaptersRef}>
        {chapters.map((ch, ci) => (
          <button
            key={ch.id}
            type="button"
            className={ci === activeChapter ? 'sf-chip is-active' : 'sf-chip'}
            onClick={() => onChapter(ci)}
            aria-current={ci === activeChapter ? 'true' : undefined}
          >
            {ch.number} {ch.title || 'Без названия'}
          </button>
        ))}
      </div>
      {steps.length > 0 && (
        <div className="sf-chips__row sf-chips__row--steps" data-chips-row="steps" ref={stepsRef}>
          {steps.map((frame) => {
            const fi = chapter.frames.indexOf(frame)
            // Глубина по номеру: «02.1» — шаг, «02.1.1» — под-шаг. По ней чип и подписан.
            const depth = Math.max(1, frame.number.split('.').length - 1)
            return (
              <button
                key={frame.id}
                type="button"
                className={fi === activeFrame ? 'sf-chip sf-chip--sub is-active' : 'sf-chip sf-chip--sub'}
                onClick={() => onFrame(activeChapter, fi)}
                title={frame.title || frame.number}
                data-depth={depth}
                aria-current={fi === activeFrame ? 'true' : undefined}
              >
                {frame.number}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
