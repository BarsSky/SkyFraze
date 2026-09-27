import { buildEventTree, type EventLike } from '../../collab/eventTree'

/**
 * Модель сценического таймлайна.
 *
 * Каждое событие — СВОЙ КАДР: глава (depth 0), под-событие (depth 1), внук (depth 2).
 * Прокрутка идёт кадр за кадром, поэтому глава «разворачивает» все свои
 * под-события по одному, прежде чем трек перейдёт к следующей главе.
 *
 * Фон кадра настраивается на самом событии (`bgKind`: inherit | tone | asset),
 * наследуясь от родителя, если не задан.
 */

export interface StageAsset {
  id: string
  url: string
  mime: string
}

export interface StageEvent extends EventLike {
  title: string
  body: string
  /** индекс в плоском массиве событий */
  flatIndex: number
  assets: StageAsset[]
  /** как показывать фон кадра: как у родителя / тон / выбранная картинка */
  bgKind: 'inherit' | 'tone' | 'asset'
  bgTone?: string
  bgAssetId?: string
  eventDate?: string | null
}

export interface FrameBackground {
  kind: 'asset' | 'tone' | 'generated'
  assetUrl?: string
  tone?: string
}

export interface TimelineFrame {
  id: string
  flatIndex: number
  depth: number
  /** 01 / 01.1 / 01.1.1 — нумерация по ветке */
  number: string
  chapterIndex: number
  chapterNumber: string
  isChapter: boolean
  eyebrow: string
  title: string
  body: string
  accent: string
  background: FrameBackground
  assets: StageAsset[]
  /** прямые дети — превью «что дальше» в копирайте */
  childFrames: TimelineFrame[]
  weight: number
}

export interface TimelineChapter extends TimelineFrame {
  /** глава + все её потомки в порядке показа (pre-order) */
  frames: TimelineFrame[]
}

export interface TimelineModel {
  chapters: TimelineChapter[]
  totalWeight: number
  frameCount: number
}

export interface StageState {
  chapterIndex: number
  chapter: TimelineChapter | null
  /** индекс кадра внутри главы: 0 — сама глава */
  frameIndex: number
  frame: TimelineFrame | null
  /** 0..1 внутри активного кадра */
  frameLocal: number
  /** 0..1 внутри главы целиком */
  chapterLocal: number
  /** 0..1 кроссфейд кадра: 0 — предыдущий кадр ещё виден */
  transition: number
  /** 0..1 по всему треку */
  progress: number
}

/** Вес кадра в единицах трека: под-событие — почти полный экран. */
export const FRAME_WEIGHT_CHAPTER = 1
export const FRAME_WEIGHT_STEP = 0.9
export const FRAME_WEIGHT_SUBSTEP = 0.75

/** Доля кадра, отведённая на переход (кроссфейд фона/копирайта). */
export const TRANSITION_BAND = 0.22

/** Сколько vh скролла приходится на единицу веса. */
export const TRACK_VH_PER_UNIT = 92

export const CHAPTER_ACCENTS_DARK = [
  '#8FB98A', '#9B7EBD', '#6FB3C9', '#D9A15B', '#C98B8B', '#7FA6D9', '#8FD1B0',
]
/**
 * Акценты светлой темы темнее пастельных: этот цвет используется и как мелкий
 * текст (eyebrow, номера кадров) на кремовом фоне, где нужен контраст ≥4.5:1.
 */
export const CHAPTER_ACCENTS_LIGHT = [
  '#3F6B37', '#5C4280', '#2C6C82', '#8A5A16', '#8A4444', '#3A5F96', '#2B7A5A',
]

/** Палитра тонов фона для выбора в редакторе. */
export const FRAME_TONES = [
  '#8FB98A', '#9B7EBD', '#6FB3C9', '#D9A15B', '#C98B8B', '#7FA6D9', '#8FD1B0', '#6D7B8C',
]

export function chapterNumber(index: number): string {
  return String(index + 1).padStart(2, '0')
}

export function stepNumber(chapterIdx: number, path: number[]): string {
  return [chapterNumber(chapterIdx), ...path.map((p) => String(p + 1))].join('.')
}

function weightForDepth(depth: number): number {
  if (depth <= 0) return FRAME_WEIGHT_CHAPTER
  if (depth === 1) return FRAME_WEIGHT_STEP
  return FRAME_WEIGHT_SUBSTEP
}

function frameBackgroundOf(item: StageEvent, accent: string, parent: FrameBackground): FrameBackground {
  if (item.bgKind === 'asset') {
    const chosen = item.bgAssetId ? item.assets.find((a) => a.id === item.bgAssetId) : undefined
    const asset = chosen ?? item.assets[0]
    if (asset) return { kind: 'asset', assetUrl: asset.url, tone: accent }
  }
  if (item.bgKind === 'tone' && item.bgTone) {
    return { kind: 'tone', tone: item.bgTone }
  }
  return parent
}

/**
 * Собирает модель из плоского списка событий (порядок = порядок массива).
 * Дерево нормализуется: сироты и участники циклов становятся главами.
 */
export function buildTimelineModel(items: StageEvent[], accents: string[]): TimelineModel {
  const palette = accents.length > 0 ? accents : CHAPTER_ACCENTS_DARK
  const roots = buildEventTree(items, 4)
  const chapters: TimelineChapter[] = []
  let totalWeight = 0
  let frameCount = 0

  roots.forEach((root, chapterIndex) => {
    // Акцент текста/неба — всегда из палитры темы: пользовательский тон кадра
    // красит ТОЛЬКО фон, иначе текст становится нечитаемым на светлой теме.
    const chapterAccent = palette[chapterIndex % palette.length]
    const frames: TimelineFrame[] = []

    const build = (
      node: typeof root,
      depth: number,
      number: string,
      parentBackground: FrameBackground,
      parentAccent: string,
    ): TimelineFrame => {
      const accent = parentAccent
      const background = frameBackgroundOf(node.item, accent, parentBackground)
      const frame: TimelineFrame = {
        id: node.item.id,
        flatIndex: node.item.flatIndex,
        depth,
        number,
        chapterIndex,
        chapterNumber: chapterNumber(chapterIndex),
        isChapter: depth === 0,
        eyebrow: depth === 0 ? 'Глава' : depth === 1 ? 'Подсобытие' : 'Под-шаг',
        title: node.item.title,
        body: node.item.body,
        accent,
        background,
        assets: node.item.assets,
        childFrames: [],
        weight: weightForDepth(depth),
      }
      frames.push(frame)
      frameCount++
      frame.childFrames = node.children.map((child, childIdx) =>
        build(child, depth + 1, `${number}.${childIdx + 1}`, background, accent),
      )
      return frame
    }

    const rootBackground: FrameBackground = { kind: 'generated', tone: chapterAccent }
    const chapterFrame = build(root, 0, chapterNumber(chapterIndex), rootBackground, chapterAccent)
    const chapter: TimelineChapter = {
      ...chapterFrame,
      frames,
      // Вес главы — сумма весов всех её кадров (глава + под-события).
      weight: frames.reduce((sum, frame) => sum + frame.weight, 0),
    }
    chapters.push(chapter)
    totalWeight += frames.reduce((sum, frame) => sum + frame.weight, 0)
  })

  return { chapters, totalWeight, frameCount }
}

/** Разрешает позицию скролла (в единицах веса) в состояние кадра. */
export function resolveScrollState(model: TimelineModel, progressUnits: number): StageState {
  if (model.chapters.length === 0) {
    return {
      chapterIndex: 0, chapter: null, frameIndex: 0, frame: null,
      frameLocal: 0, chapterLocal: 0, transition: 1, progress: 0,
    }
  }

  const clamped = Math.max(0, Math.min(model.totalWeight, progressUnits))
  const overall = model.totalWeight > 0 ? clamped / model.totalWeight : 0

  let cursor = 0
  for (let ci = 0; ci < model.chapters.length; ci++) {
    const chapter = model.chapters[ci]
    const end = cursor + chapter.weight
    if (clamped < end || ci === model.chapters.length - 1) {
      const local = Math.max(0, Math.min(chapter.weight, clamped - cursor))
      let frameCursor = 0
      for (let fi = 0; fi < chapter.frames.length; fi++) {
        const frame = chapter.frames[fi]
        const isLast = fi === chapter.frames.length - 1
        if (local < frameCursor + frame.weight || isLast) {
          const frameLocal = frame.weight > 0
            ? Math.max(0, Math.min(1, (local - frameCursor) / frame.weight))
            : 0
          const firstFrameOfModel = ci === 0 && fi === 0
          const transition = firstFrameOfModel
            ? 1
            : Math.max(0, Math.min(1, frameLocal / TRANSITION_BAND))
          return {
            chapterIndex: ci,
            chapter,
            frameIndex: fi,
            frame,
            frameLocal,
            chapterLocal: chapter.weight > 0 ? local / chapter.weight : 0,
            transition,
            progress: overall,
          }
        }
        frameCursor += frame.weight
      }
    }
    cursor = end
  }

  const lastChapter = model.chapters[model.chapters.length - 1]
  const lastFrame = lastChapter.frames[lastChapter.frames.length - 1]
  return {
    chapterIndex: model.chapters.length - 1,
    chapter: lastChapter,
    frameIndex: lastChapter.frames.length - 1,
    frame: lastFrame,
    frameLocal: 1,
    chapterLocal: 1,
    transition: 1,
    progress: 1,
  }
}

/** Единицы веса до указанной главы (для прыжков по маршруту). */
export function unitsBeforeChapter(model: TimelineModel, chapterIndex: number): number {
  return model.chapters.slice(0, Math.max(0, chapterIndex)).reduce((sum, c) => sum + c.weight, 0)
}

/** Единицы веса до указанного кадра внутри главы (для прыжков по шагам). */
export function unitsBeforeFrame(model: TimelineModel, chapterIndex: number, frameIndex: number): number {
  const chapter = model.chapters[chapterIndex]
  if (!chapter) return 0
  const before = chapter.frames
    .slice(0, Math.max(0, frameIndex))
    .reduce((sum, f) => sum + f.weight, 0)
  return unitsBeforeChapter(model, chapterIndex) + before
}
