import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ChapterChips } from './ChapterChips'
import type { TimelineChapter } from '../timelineModel'

/**
 * Полоса чипов на телефоне (0.88.0): ДВЕ строки — главы сверху, под-события активной главы снизу.
 *
 * Зачем: раньше всё шло одной строкой («сначала все главы, потом подсобытия главы»), и было
 * неясно, где кончаются главы и начинаются шаги (отчёт с телефона).
 */

const frame = (id: string, number: string, title: string, isChapter = false) =>
  ({
    id,
    number,
    title,
    body: '',
    weight: 1,
    depth: isChapter ? 0 : 1,
    isChapter,
    flatIndex: 0,
    kind: 'event',
  }) as unknown as TimelineChapter['frames'][number]

const chapters = [
  {
    id: 'ch1',
    number: '01',
    title: 'Пролог',
    frames: [frame('f1', '01', 'Пролог', true), frame('f2', '01.1', 'Первая сцена'), frame('f3', '01.1.1', 'Под-шаг')],
  },
  {
    id: 'ch2',
    number: '02',
    title: 'Развязка',
    frames: [frame('f4', '02', 'Развязка', true), frame('f5', '02.1', 'Финал')],
  },
] as unknown as TimelineChapter[]

// jsdom не умеет scrollIntoView: полоса подкручивает активный чип.
beforeEachStub()
function beforeEachStub() {
  ;(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn()
}

afterEach(() => cleanup())

const renderChips = (activeChapter = 0, activeFrame = 1) =>
  render(
    <ChapterChips
      chapters={chapters}
      activeChapter={activeChapter}
      activeFrame={activeFrame}
      onChapter={vi.fn()}
      onFrame={vi.fn()}
    />,
  )

describe('ChapterChips — две полосы', () => {
  it('главы в верхней полосе, под-события активной главы — в нижней', () => {
    const { container } = renderChips(0, 1)
    const chaptersRow = container.querySelector('[data-chips-row="chapters"]') as HTMLElement
    const stepsRow = container.querySelector('[data-chips-row="steps"]') as HTMLElement
    expect(chaptersRow.querySelectorAll('.sf-chip').length).toBe(2)
    expect(stepsRow.querySelectorAll('.sf-chip').length).toBe(2)
    // Глава в нижнюю полосу не попадает: она уже есть сверху.
    expect(Array.from(stepsRow.querySelectorAll('.sf-chip')).map((chip) => chip.textContent)).toEqual([
      '01.1',
      '01.1.1',
    ])
    // Полосы идут одна под другой: нижняя начинается ниже верхней.
    expect(stepsRow.getAttribute('data-chips-row')).toBe('steps')
  })

  it('глубина шага видна атрибутом: под-шаг мельче', () => {
    const { container } = renderChips(0, 1)
    const steps = Array.from(container.querySelectorAll('[data-chips-row="steps"] .sf-chip'))
    expect(steps.map((chip) => chip.getAttribute('data-depth'))).toEqual(['1', '2'])
  })

  it('смена главы меняет нижнюю полосу и активный чип', () => {
    const { container, rerender } = renderChips(0, 1)
    expect(container.querySelectorAll('[data-chips-row="steps"] .sf-chip').length).toBe(2)
    rerender(
      <ChapterChips chapters={chapters} activeChapter={1} activeFrame={1} onChapter={vi.fn()} onFrame={vi.fn()} />,
    )
    const steps = Array.from(container.querySelectorAll('[data-chips-row="steps"] .sf-chip'))
    expect(steps.map((chip) => chip.textContent)).toEqual(['02.1'])
    expect(container.querySelectorAll('.sf-chips .is-active').length).toBe(2) // глава и шаг
  })

  it('у главы без под-событий нижней полосы нет', () => {
    const single = [
      { id: 'ch1', number: '01', title: 'Пролог', frames: [frame('f1', '01', 'Пролог', true)] },
    ] as unknown as TimelineChapter[]
    const { container } = render(
      <ChapterChips chapters={single} activeChapter={0} activeFrame={0} onChapter={vi.fn()} onFrame={vi.fn()} />,
    )
    expect(container.querySelector('[data-chips-row="chapters"]')).toBeTruthy()
    expect(container.querySelector('[data-chips-row="steps"]')).toBeNull()
  })

  it('нажатия отдают главу и кадр', () => {
    const onChapter = vi.fn()
    const onFrame = vi.fn()
    const { container } = render(
      <ChapterChips chapters={chapters} activeChapter={0} activeFrame={1} onChapter={onChapter} onFrame={onFrame} />,
    )
    fireEvent.click(container.querySelectorAll('[data-chips-row="chapters"] .sf-chip')[1])
    expect(onChapter).toHaveBeenCalledWith(1)
    fireEvent.click(container.querySelectorAll('[data-chips-row="steps"] .sf-chip')[0])
    // Номер кадра — индекс в кадрах главы, а не в полосе: 01.1 — это второй кадр.
    expect(onFrame).toHaveBeenCalledWith(0, 1)
  })
})
