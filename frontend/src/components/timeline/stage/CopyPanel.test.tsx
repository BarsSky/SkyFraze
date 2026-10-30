import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CopyPanel } from './CopyPanel'
import { buildTimelineModel, type StageEvent } from '../timelineModel'
import { setLang } from '../../../store/lang'

/**
 * Копирайт кадра (0.123.0).
 *
 * Что закрепляем: подписи вокруг данных переведены и НЕ съедают сами данные. Кадр — это
 * «глава 01: Пролог · дата: 2 марта · картинок: 1», и в английском «глава» → «chapter», а
 * название главы и подпись связи остаются как их написал человек. До 0.123.0 эта обвязка
 * была русскими литералами в разметке, то есть английская стадия выглядела наполовину
 * переведённой.
 */

const event = (partial: Partial<StageEvent> & { id: string; title: string }): StageEvent => ({
  parentId: null,
  body: '',
  flatIndex: 0,
  assets: [],
  bgKind: 'inherit',
  ...partial,
})

const ITEMS: StageEvent[] = [
  event({ id: 'c1', title: 'Пролог', flatIndex: 0 }),
  event({ id: 's11', parentId: 'c1', title: 'Сцена', flatIndex: 1, body: 'Текст кадра.' }),
]

function firstFrame() {
  const model = buildTimelineModel(ITEMS, ['#111111'])
  const chapter = model.chapters[0]
  return { chapter, frame: chapter.frames[1] }
}

afterEach(() => {
  cleanup()
  setLang('ru')
})

describe('CopyPanel', () => {
  it('русские подписи на месте: глава, дата и порядок кадра', () => {
    const { chapter, frame } = firstFrame()
    render(
      <CopyPanel
        chapter={chapter}
        frame={frame}
        onJumpFrame={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
        prevLabel="01"
        nextLabel="01.2"
      />,
    )
    expect(screen.getByText(/глава 01: Пролог/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /назад: 01/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /дальше: 01.2/ })).toBeTruthy()
  })

  it('на английском обвязка переведена, а название главы — данные', () => {
    setLang('en')
    const { chapter, frame } = firstFrame()
    render(
      <CopyPanel
        chapter={chapter}
        frame={frame}
        onJumpFrame={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
        prevLabel="01"
        nextLabel="01.2"
      />,
    )
    // Название главы «Пролог» не переводится: это текст проекта.
    expect(screen.getByText(/chapter 01: Пролог/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /back: 01/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /next: 01.2/ })).toBeTruthy()
  })

  it('без следующего кадра кнопка говорит «конец таймлайна» и по-английски тоже', () => {
    const { chapter, frame } = firstFrame()
    render(<CopyPanel chapter={chapter} frame={frame} onJumpFrame={() => {}} onPrev={() => {}} />)
    expect(screen.getByRole('button', { name: 'конец таймлайна' })).toBeTruthy()

    cleanup()
    setLang('en')
    render(<CopyPanel chapter={chapter} frame={frame} onJumpFrame={() => {}} onPrev={() => {}} />)
    expect(screen.getByRole('button', { name: 'end of the timeline' })).toBeTruthy()
  })

  /**
   * 0.132.0: текст кадра размечен для выделения. Меню (и смещения в исходнике) ищут кадр по
   * `data-frame-body`, а исходник берут из `data-frame-source` — без этой обвязки выделение
   * некуда привязать.
   */
  it('текст кадра отмечен для выделения фрагмента', () => {
    const { chapter, frame } = firstFrame()
    const { container } = render(
      <CopyPanel chapter={chapter} frame={frame} onJumpFrame={() => {}} onPrev={() => {}} />,
    )
    const body = container.querySelector('[data-frame-body]') as HTMLElement
    expect(body).toBeTruthy()
    expect(body.getAttribute('data-frame-body')).toBe(frame.id)
    expect(body.getAttribute('data-frame-source')).toContain('Текст кадра.')
  })

  /**
   * 0.133.0: «показать в проекте» — кадр открылся, и фраза подсвечена.
   *
   * В jsdom нет CSS Custom Highlight API, поэтому здесь работает запасной путь (<mark>) — тот же,
   * что достанется браузерам без API.
   */
  it('подсвечивает фразу, к которой пришли из чата', () => {
    const { chapter, frame } = firstFrame()
    const { container } = render(
      <CopyPanel
        chapter={chapter}
        frame={frame}
        onJumpFrame={() => {}}
        onPrev={() => {}}
        highlight={{ frameId: frame.id, quote: 'Текст кадра', nonce: 1 }}
      />,
    )
    const mark = container.querySelector('[data-quote-mark]')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('Текст кадра')
    expect(container.querySelector('[data-quote-missing]')).toBeNull()
  })

  it('если фразы в кадре уже нет — говорит об этом, а не подсвечивает первое похожее', () => {
    const { chapter, frame } = firstFrame()
    const { container } = render(
      <CopyPanel
        chapter={chapter}
        frame={frame}
        onJumpFrame={() => {}}
        onPrev={() => {}}
        highlight={{ frameId: frame.id, quote: 'Совсем другой текст', nonce: 2 }}
      />,
    )
    expect(container.querySelector('[data-quote-mark]')).toBeNull()
    expect(container.querySelector('[data-quote-missing]')!.textContent).toContain(
      'Совсем другой текст',
    )
  })

  it('подсветка чужого кадра не применяется', () => {
    const { chapter, frame } = firstFrame()
    const { container } = render(
      <CopyPanel
        chapter={chapter}
        frame={frame}
        onJumpFrame={() => {}}
        onPrev={() => {}}
        highlight={{ frameId: 'other', quote: 'Текст кадра', nonce: 3 }}
      />,
    )
    expect(container.querySelector('[data-quote-mark]')).toBeNull()
    expect(container.querySelector('[data-quote-missing]')).toBeNull()
  })
})
