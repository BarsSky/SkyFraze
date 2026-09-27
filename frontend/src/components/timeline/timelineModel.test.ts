import { describe, expect, it } from 'vitest'
import {
  FRAME_WEIGHT_CHAPTER,
  FRAME_WEIGHT_STEP,
  FRAME_WEIGHT_SUBSTEP,
  TRANSITION_BAND,
  buildTimelineModel,
  chapterNumber,
  resolveScrollState,
  stepNumber,
  unitsBeforeChapter,
  unitsBeforeFrame,
  type StageAsset,
  type StageEvent,
} from './timelineModel'

const asset = (id: string): StageAsset => ({ id, url: `/api/assets/${id}`, mime: 'image/png' })

const ev = (
  id: string,
  parentId: string | null,
  title: string,
  flatIndex: number,
  extra: Partial<StageEvent> = {},
): StageEvent => ({
  id,
  parentId,
  title,
  body: `${title} body`,
  flatIndex,
  assets: [],
  bgKind: 'inherit',
  ...extra,
})

// Глава 1 (шаг 1.1 с под-шагом 1.1.1, шаг 1.2), Глава 2 без шагов, сирота → глава 3
const ITEMS: StageEvent[] = [
  ev('c1', null, 'Глава 1', 0),
  ev('s11', 'c1', 'Шаг 1.1', 1),
  ev('s111', 's11', 'Под-шаг 1.1.1', 2),
  ev('s12', 'c1', 'Шаг 1.2', 3),
  ev('c2', null, 'Глава 2', 4),
  ev('orphan', 'missing-parent', 'Осиротевшее', 5),
]

describe('buildTimelineModel', () => {
  it('каждое событие становится кадром главы, порядок — pre-order', () => {
    const model = buildTimelineModel(ITEMS, ['#111111', '#222222'])
    expect(model.chapters.map((c) => c.title)).toEqual(['Глава 1', 'Глава 2', 'Осиротевшее'])
    expect(model.chapters[0].frames.map((f) => f.number)).toEqual(['01', '01.1', '01.1.1', '01.2'])
    expect(model.chapters[0].frames.map((f) => f.depth)).toEqual([0, 1, 2, 1])
    expect(model.chapters[0].frames[0].isChapter).toBe(true)
    expect(model.chapters[0].frames[1].isChapter).toBe(false)
    expect(model.frameCount).toBe(6)
    // flatIndex сохраняется — по нему редактор находит событие
    expect(model.chapters[0].frames[2].flatIndex).toBe(2)
  })

  it('вес кадра: глава > под-событие > под-шаг', () => {
    const model = buildTimelineModel(ITEMS, ['#111111'])
    const weights = model.chapters[0].frames.map((f) => f.weight)
    expect(weights).toEqual([FRAME_WEIGHT_CHAPTER, FRAME_WEIGHT_STEP, FRAME_WEIGHT_SUBSTEP, FRAME_WEIGHT_STEP])
    expect(model.chapters[0].weight).toBeCloseTo(weights.reduce((s, w) => s + w, 0))
    expect(model.totalWeight).toBeCloseTo(model.chapters.reduce((s, c) => s + c.weight, 0))
  })

  it('акценты глав идут по кругу палитры', () => {
    const model = buildTimelineModel(ITEMS, ['#aaa', '#bbb'])
    expect(model.chapters.map((c) => c.accent)).toEqual(['#aaa', '#bbb', '#aaa'])
  })

  it('фон наследуется от родителя, тон и картинка переопределяют', () => {
    const items: StageEvent[] = [
      ev('c', null, 'Глава', 0, { bgKind: 'asset', assets: [asset('img1')] }),
      ev('s1', 'c', 'Наследует', 1),
      ev('s2', 'c', 'Свой тон', 2, { bgKind: 'tone', bgTone: '#123456' }),
      ev('s3', 'c', 'Своя картинка', 3, { bgKind: 'asset', assets: [asset('a'), asset('b')], bgAssetId: 'b' }),
    ]
    const chapter = buildTimelineModel(items, ['#000000']).chapters[0]
    expect(chapter.frames[0].background.kind).toBe('asset')
    expect(chapter.frames[0].background.assetUrl).toBe('/api/assets/img1')
    // наследование картинки главы
    expect(chapter.frames[1].background.kind).toBe('asset')
    expect(chapter.frames[1].background.assetUrl).toBe('/api/assets/img1')
    // свой тон
    expect(chapter.frames[2].background).toEqual({ kind: 'tone', tone: '#123456' })
    // тон красит фон, но не текст: акцент остаётся из палитры темы
    expect(chapter.frames[2].accent).toBe('#000000')
    // выбранная картинка из вложений
    expect(chapter.frames[3].background.assetUrl).toBe('/api/assets/b')
  })

  it('без настроек фон — процедурный (generated) с тоном главы', () => {
    const chapter = buildTimelineModel(ITEMS, ['#abcdef']).chapters[0]
    expect(chapter.frames[0].background.kind).toBe('generated')
    expect(chapter.frames[0].accent).toBe('#abcdef')
  })

  it('пустой список даёт пустую модель', () => {
    const model = buildTimelineModel([], ['#aaa'])
    expect(model.chapters).toEqual([])
    expect(model.totalWeight).toBe(0)
    expect(model.frameCount).toBe(0)
  })
})

describe('resolveScrollState', () => {
  const model = buildTimelineModel(ITEMS, ['#aaa', '#bbb', '#ccc'])

  it('в начале трека — первый кадр первой главы', () => {
    const s = resolveScrollState(model, 0)
    expect(s.chapterIndex).toBe(0)
    expect(s.frameIndex).toBe(0)
    expect(s.frame?.number).toBe('01')
    expect(s.transition).toBe(1)
    expect(s.progress).toBe(0)
  })

  it('внутри главы кадры идут по одному: 01 → 01.1 → 01.1.1 → 01.2', () => {
    const seen: string[] = []
    const step = model.chapters[0].weight / 400
    for (let p = 0; p <= model.chapters[0].weight; p += step) {
      const s = resolveScrollState(model, p)
      const n = s.frame?.number ?? ''
      if (seen[seen.length - 1] !== n) seen.push(n)
    }
    expect(seen).toEqual(['01', '01.1', '01.1.1', '01.2'])
  })

  it('под-событие получает почти полный кадр (окно, а не строка списка)', () => {
    const start = unitsBeforeFrame(model, 0, 1)
    const mid = resolveScrollState(model, start + FRAME_WEIGHT_STEP * 0.5)
    expect(mid.frame?.number).toBe('01.1')
    expect(mid.frameLocal).toBeCloseTo(0.5)
  })

  it('переход к следующему кадру нарастает в пределах TRANSITION_BAND', () => {
    const start = unitsBeforeFrame(model, 0, 1)
    expect(resolveScrollState(model, start).transition).toBe(0)
    const midBand = resolveScrollState(model, start + FRAME_WEIGHT_STEP * TRANSITION_BAND * 0.5)
    expect(midBand.transition).toBeGreaterThan(0)
    expect(midBand.transition).toBeLessThan(1)
    const afterBand = resolveScrollState(model, start + FRAME_WEIGHT_STEP * TRANSITION_BAND * 1.5)
    expect(afterBand.transition).toBe(1)
  })

  it('после последнего под-события трек уходит на следующую главу', () => {
    const s = resolveScrollState(model, model.chapters[0].weight + 0.01)
    expect(s.chapterIndex).toBe(1)
    expect(s.frameIndex).toBe(0)
    expect(s.frame?.number).toBe('02')
  })

  it('кадры монотонно растут по мере скролла', () => {
    const flatIndex = (ci: number, fi: number) =>
      model.chapters.slice(0, ci).reduce((sum, c) => sum + c.frames.length, 0) + fi
    let last = -1
    const step = model.totalWeight / 300
    for (let p = 0; p <= model.totalWeight; p += step) {
      const s = resolveScrollState(model, p)
      const flat = flatIndex(s.chapterIndex, s.frameIndex)
      expect(flat).toBeGreaterThanOrEqual(last)
      last = flat
    }
  })

  it('выход за границы не ломает состояние', () => {
    expect(resolveScrollState(model, -50).progress).toBe(0)
    const over = resolveScrollState(model, model.totalWeight + 50)
    expect(over.progress).toBe(1)
    expect(over.frameIndex).toBe(model.chapters[model.chapters.length - 1].frames.length - 1)
  })
})

describe('нумерация и позиции', () => {
  it('chapterNumber/stepNumber дают 01 и 01.1.1', () => {
    expect(chapterNumber(0)).toBe('01')
    expect(chapterNumber(9)).toBe('10')
    expect(stepNumber(0, [0])).toBe('01.1')
    expect(stepNumber(1, [2, 0])).toBe('02.3.1')
  })

  it('unitsBeforeChapter/unitsBeforeFrame считают начало окон', () => {
    const model = buildTimelineModel(ITEMS, ['#aaa'])
    expect(unitsBeforeChapter(model, 0)).toBe(0)
    expect(unitsBeforeChapter(model, 1)).toBeCloseTo(model.chapters[0].weight)
    expect(unitsBeforeFrame(model, 0, 0)).toBe(0)
    expect(unitsBeforeFrame(model, 0, 1)).toBeCloseTo(FRAME_WEIGHT_CHAPTER)
  })
})
