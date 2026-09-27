import type { ReactNode } from 'react'
import type { TimelineChapter } from '../timelineModel'

interface Props {
  projectTitle?: string
  chapters: TimelineChapter[]
  activeChapter: number
  onChapter: (index: number) => void
  actions?: ReactNode
}

/**
 * Верхняя панель стадии: название проекта, пилюли глав и действия страницы.
 * На узких экранах пилюли скрыты — их роль берут на себя чипы (ChapterChips).
 */
export function StageTopBar({ projectTitle, chapters, activeChapter, onChapter, actions }: Props) {
  return (
    <div className="sf-topbar">
      <span className="sf-topbar__title">{projectTitle ?? 'Таймлайн'}</span>
      <nav className="sf-nav" aria-label="Главы">
        {chapters.map((chapter, ci) => (
          <button
            key={chapter.id}
            type="button"
            className={ci === activeChapter ? 'sf-nav__item is-active' : 'sf-nav__item'}
            onClick={() => onChapter(ci)}
            title={chapter.title}
          >
            {chapter.number}
          </button>
        ))}
      </nav>
      <div className="sf-topbar__actions">{actions}</div>
    </div>
  )
}
