import type { ReactNode } from 'react'
import type { TimelineChapter } from '../timelineModel'
import { BrandMark } from '../../BrandMark'

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
 *
 * Знак проекта стоит рядом с названием — тем же рисунком, что и favicon: так
 * вкладка и страница узнаются как одно.
 */
export function StageTopBar({ projectTitle, chapters, activeChapter, onChapter, actions }: Props) {
  return (
    <div className="sf-topbar">
      <span className="sf-topbar__title">
        <BrandMark size={22} className="sf-topbar__mark" />
        <span className="sf-topbar__name">{projectTitle ?? 'Таймлайн'}</span>
      </span>
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
