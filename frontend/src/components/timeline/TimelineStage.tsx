import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { yEnsureEventIds, yEventParentId, type YArray, type YMap } from '../../collab/yprovider'
import { getScrollRoot, prefersReducedMotion, visibleBox } from './scrollRoot'
import {
  CHAPTER_ACCENTS_DARK,
  CHAPTER_ACCENTS_LIGHT,
  TRACK_VH_PER_UNIT,
  buildTimelineModel,
  resolveScrollState,
  unitsBeforeChapter,
  unitsBeforeFrame,
  type StageAsset,
  type StageEvent,
  type StageState,
  type TimelineFrame,
} from './timelineModel'
import { useTheme } from '../../store/theme'
import { SkyLayer } from './stage/SkyLayer'
import { SceneFrame } from './stage/SceneFrame'
import { CopyPanel } from './stage/CopyPanel'
import { RouteTree } from './stage/RouteTree'
import { ChapterChips } from './stage/ChapterChips'
import { StageTopBar } from './stage/StageTopBar'

export interface AssetLookup {
  url: string
  mime: string
}

interface Props {
  events: YArray
  /** id ассета → url/mime (для фонов кадров и картинок событий) */
  assetsById: Record<string, AssetLookup>
  projectTitle?: string
  /** Кнопки страницы в верхней панели стадии. */
  actions?: ReactNode
  /** Блок под навигацией кадра (например, оценка и просмотры публичной истории). */
  copyFooter?: ReactNode
}

interface EventMeta {
  id: string
  parentId: string | null
  title: string
  body: string
  assetIds: string[]
  bgKind: 'inherit' | 'tone' | 'asset'
  bgTone?: string
  bgAssetId?: string
  eventDate: string | null
}

function normalizeBgKind(value: unknown): 'inherit' | 'tone' | 'asset' {
  return value === 'tone' || value === 'asset' ? value : 'inherit'
}

function resolveAssets(assetIds: string[], lookup: Record<string, AssetLookup>): StageAsset[] {
  const out: StageAsset[] = []
  for (const id of assetIds) {
    const found = lookup[id]
    if (found) out.push({ id, url: found.url, mime: found.mime })
  }
  return out
}

/**
 * Сценический таймлайн: fixed-стадия + невидимый трек скролла.
 *
 * Каждое событие — отдельный кадр: глава, затем по одному все её под-события
 * (и их под-шаги), поэтому глава полностью «разворачивает» вложенность, прежде
 * чем трек перейдёт к следующей главе. Фон кадра настраивается на событии.
 *
 * Стадия занимается только показом и навигацией: редактор — отдельный модуль.
 */
export function TimelineStage({ events, assetsById, projectTitle, actions, copyFooter }: Props) {
  const [theme] = useTheme()
  const trackRef = useRef<HTMLDivElement>(null)
  const stageActiveRef = useRef(true)
  const [meta, setMeta] = useState<EventMeta[]>([])
  const [state, setState] = useState<StageState>(() =>
    resolveScrollState({ chapters: [], totalWeight: 0, frameCount: 0 }, 0),
  )
  const [stageActive, setStageActive] = useState(true)

  // Фиксированные слои стадии не должны заезжать под шапку приложения: на телефоне
  // шапка переносится и становится выше, и кнопка «Редакторы» оказывалась под ней.
  // Поэтому высоту шапки измеряем и отдаём в CSS переменной --sf-header-h.
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('.layout header')
    const apply = () => {
      const h = header ? Math.round(header.getBoundingClientRect().height) : 0
      document.documentElement.style.setProperty('--sf-header-h', `${h}px`)
    }
    apply()
    const ro = header && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    if (ro && header) ro.observe(header)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      document.documentElement.style.removeProperty('--sf-header-h')
    }
  }, [])

  // ── Данные из CRDT: тексты, вложения и настройки фона кадра
  useEffect(() => {
    if (!events) return
    yEnsureEventIds(events)
    const update = () => {
      const arr = events.toArray() as YMap[]
      setMeta(
        arr
          .map((m) => ({
            id: (m.get('id') as string | undefined) ?? '',
            parentId: yEventParentId(m),
            title: ((m.get('title') as string | undefined) ?? '').trim(),
            body: ((m.get('body') as string | undefined) ?? '').trim(),
            assetIds: ((m.get('assets') as string[] | undefined) ?? []).filter(Boolean),
            bgKind: normalizeBgKind(m.get('bg_kind')),
            bgTone: (m.get('bg_tone') as string | undefined) || undefined,
            bgAssetId: (m.get('bg_asset') as string | undefined) || undefined,
            eventDate: (m.get('event_date') as string | undefined) ?? null,
          }))
          .filter((e) => e.id.length > 0),
      )
    }
    update()
    events.observeDeep(update)
    return () => events.unobserveDeep(update)
  }, [events])

  const items = useMemo<StageEvent[]>(
    () =>
      meta.map((m, i) => ({
        id: m.id,
        parentId: m.parentId,
        title: m.title,
        body: m.body,
        flatIndex: i,
        assets: resolveAssets(m.assetIds, assetsById),
        bgKind: m.bgKind,
        bgTone: m.bgTone,
        bgAssetId: m.bgAssetId,
        eventDate: m.eventDate,
      })),
    [meta, assetsById],
  )

  const accents = theme === 'light' ? CHAPTER_ACCENTS_LIGHT : CHAPTER_ACCENTS_DARK
  const model = useMemo(() => buildTimelineModel(items, accents), [items, accents])

  // Плоский список кадров по всему таймлайну — для переходов «назад/дальше»
  // сквозь главы (а не только внутри текущей).
  const flatFrames = useMemo(
    () =>
      model.chapters.flatMap((chapter) =>
        chapter.frames.map((frame, frameIndex) => ({
          id: frame.id,
          number: frame.number,
          chapterIndex: chapter.chapterIndex,
          frameIndex,
        })),
      ),
    [model.chapters],
  )

  // ── Скролл → состояние кадра. Значения квантуются: плавность даёт CSS.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let raf = 0
    let last = { chapter: -1, frame: -2, transition: -1, local: -1 }

    const tick = () => {
      const box = visibleBox(null)
      const rect = track.getBoundingClientRect()
      const viewport = Math.max(1, box.bottom - box.top)
      const scrollable = Math.max(1, rect.height - viewport)
      const passed = box.top - rect.top
      const progress = Math.max(0, Math.min(1, passed / scrollable))
      const next = resolveScrollState(model, progress * model.totalWeight)

      // Стадия живёт, пока трек занимает существенную часть вьюпорта. Иначе её
      // fixed-слои перекрывают блок редакторов под треком и крадут клики.
      const visibleTrack = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)
      const inView = visibleTrack > viewport * 0.5
      if (inView !== stageActiveRef.current) {
        stageActiveRef.current = inView
        setStageActive(inView)
      }

      const qTransition = Math.round(next.transition * 20) / 20
      const qLocal = Math.round(next.frameLocal * 50) / 50
      if (
        next.chapterIndex !== last.chapter ||
        next.frameIndex !== last.frame ||
        qTransition !== last.transition ||
        qLocal !== last.local
      ) {
        last = { chapter: next.chapterIndex, frame: next.frameIndex, transition: qTransition, local: qLocal }
        setState({ ...next, transition: qTransition, frameLocal: qLocal })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [model])

  const jumpToUnits = useCallback(
    (units: number) => {
      const track = trackRef.current
      if (!track) return
      const root = getScrollRoot(track)
      const box = visibleBox(root)
      const rect = track.getBoundingClientRect()
      const pxPerUnit = rect.height / Math.max(1, model.totalWeight)
      const delta = rect.top - box.top + units * pxPerUnit
      const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
      if (root && root !== document.scrollingElement) {
        root.scrollTo({ top: root.scrollTop + delta, behavior })
      } else {
        window.scrollTo({ top: window.scrollY + delta, behavior })
      }
    },
    [model.totalWeight],
  )

  const jumpToChapter = useCallback(
    (chapterIndex: number) => jumpToUnits(unitsBeforeChapter(model, chapterIndex)),
    [model, jumpToUnits],
  )

  const jumpToFrame = useCallback(
    (chapterIndex: number, frameIndex: number) => jumpToUnits(unitsBeforeFrame(model, chapterIndex, frameIndex)),
    [model, jumpToUnits],
  )

  // Автопереходов нет: создание события в редакторе не должно уводить стадию —
  // пользователь остаётся в редакторе и правит текст.

  if (!events || model.chapters.length === 0) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center' }}>
        <p className="muted">Нет событий. Добавьте главу в блоке «Редакторы».</p>
      </div>
    )
  }

  const chapter = state.chapter
  const frame = state.frame ?? chapter?.frames[0] ?? null
  const accent = frame?.accent ?? accents[0]
  const flatIndex = frame ? flatFrames.findIndex((entry) => entry.id === frame.id) : -1
  const prevEntry = flatIndex > 0 ? flatFrames[flatIndex - 1] : undefined
  const nextEntry = flatIndex >= 0 && flatIndex < flatFrames.length - 1 ? flatFrames[flatIndex + 1] : undefined

  // Видимые слои: активный кадр + предыдущий (кроссфейд внутри главы и на стыке глав).
  const layers: Array<{ frame: TimelineFrame; role: 'active' | 'previous' }> = []
  if (frame && chapter) {
    layers.push({ frame, role: 'active' })
    if (state.frameIndex > 0) {
      const previous = chapter.frames[state.frameIndex - 1]
      if (previous) layers.push({ frame: previous, role: 'previous' })
    } else if (state.chapterIndex > 0) {
      const previousChapter = model.chapters[state.chapterIndex - 1]
      const previous = previousChapter?.frames[previousChapter.frames.length - 1]
      if (previous) layers.push({ frame: previous, role: 'previous' })
    }
  }

  return (
    <div
      className="sf-root"
      data-stage={stageActive ? 'active' : 'idle'}
      data-chapter={chapter?.number ?? ''}
      data-frame-number={frame?.number ?? ''}
      data-frame-index={state.frameIndex}
      data-frames-in-chapter={chapter?.frames.length ?? 0}
      style={{ ['--sf-accent' as string]: accent }}
    >
      <div className="sf-progress" aria-hidden>
        <span style={{ transform: `scaleX(${state.progress})` }} />
      </div>

      <StageTopBar
        projectTitle={projectTitle}
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        onChapter={jumpToChapter}
        actions={actions}
      />

      <div className="sf-stage" aria-hidden>
        <SkyLayer accent={accent} tone={frame?.background.tone} />
        {layers.map(({ frame: layerFrame, role }) => {
          const opacity = role === 'active' ? state.transition : 1 - state.transition
          return (
            <div
              key={layerFrame.id}
              className="sf-scene"
              data-frame-id={layerFrame.id}
              data-active={role === 'active' ? 'true' : 'false'}
              style={{ opacity, zIndex: role === 'active' ? 2 : 1 }}
            >
              <SceneFrame frame={layerFrame} local={role === 'active' ? state.frameLocal : 1} />
            </div>
          )
        })}
      </div>

      <div className="sf-copylayer">
        {chapter && frame && (
          <CopyPanel
            chapter={chapter}
            frame={frame}
            frameIndex={state.frameIndex}
            onJumpFrame={jumpToFrame}
            onPrev={prevEntry ? () => jumpToFrame(prevEntry.chapterIndex, prevEntry.frameIndex) : undefined}
            onNext={nextEntry ? () => jumpToFrame(nextEntry.chapterIndex, nextEntry.frameIndex) : undefined}
            prevLabel={prevEntry?.number}
            nextLabel={nextEntry?.number}
            footer={copyFooter}
          />
        )}
      </div>

      <RouteTree
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        activeFrame={state.frameIndex}
        onChapter={jumpToChapter}
        onFrame={jumpToFrame}
      />
      <ChapterChips
        chapters={model.chapters}
        activeChapter={state.chapterIndex}
        activeFrame={state.frameIndex}
        onChapter={jumpToChapter}
        onFrame={jumpToFrame}
      />

      <div className="sf-hint" style={{ opacity: state.progress > 0.01 ? 0 : 1 }}>
        <span>прокрутите — кадры идут по порядку</span>
        <i />
      </div>

      <div
        className="sf-track"
        ref={trackRef}
        style={{ height: `${Math.max(1, model.totalWeight) * TRACK_VH_PER_UNIT}vh` }}
      />
    </div>
  )
}
