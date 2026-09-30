import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Y from 'yjs'
import { yAddEvent, yEventParentId } from '../../collab/yprovider'
import { EditorsPanel } from './EditorsPanel'

/**
 * Перетаскивание строк дерева в навигаторе редакторов.
 *
 * Тянем синтетическими pointer-событиями: компонент слушает `pointerdown` строки
 * и `pointermove`/`pointerup` окна (HTML5 drag-and-drop на тач-устройствах не
 * работает, поэтому его тут нет вовсе). Геометрия строк в jsdom нулевая, поэтому
 * у цели подменяем `getBoundingClientRect` — так проверяются обе зоны сброса:
 * правая часть строки «внутрь», левая половина «перед/после».
 */

/** jsdom не реализует PointerEvent: без неё события не несут ни id, ни тип. */
class FakePointerEvent extends MouseEvent {
  pointerId: number
  pointerType: string
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = (init as { pointerId?: number }).pointerId ?? 1
    this.pointerType = (init as { pointerType?: string }).pointerType ?? 'mouse'
  }
}

// Редактор события тянет за собой markdown-it/katex/mermaid — для проверки
// переноса строк это лишние секунды на импорт и лишняя нагрузка на соседние
// тесты в том же воркере.
vi.mock('./EventEditor', () => ({ EventEditor: () => null }))

beforeAll(() => {
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent
})

afterEach(() => cleanup())

const ROW = { left: 0, width: 200, height: 34 }

/** Подменяет геометрию строки: jsdom отдаёт нули, а зоны считаются по rect. */
function placeRow(el: HTMLElement, top: number) {
  el.getBoundingClientRect = () => ({
    left: ROW.left,
    top,
    width: ROW.width,
    height: ROW.height,
    right: ROW.left + ROW.width,
    bottom: top + ROW.height,
    x: ROW.left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

function makeEvents() {
  const doc = new Y.Doc()
  const events = doc.getArray<Y.Map<unknown>>('events')
  const chapter1 = yAddEvent(events, 'Глава 1')
  const sub = yAddEvent(events, 'Подсобытие', '', { parentId: chapter1.get('id') as string })
  const chapter2 = yAddEvent(events, 'Глава 2')
  return { doc, events, chapter1, sub, chapter2 }
}

function show(events: Y.Array<Y.Map<unknown>>, onChanged = vi.fn()) {
  render(
    <EditorsPanel
      events={events}
      assets={[]}
      assetUrls={{}}
      onChanged={onChanged}
      onUpload={async () => null}
    />,
  )
  return onChanged
}

const rowEl = (title: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ed-row')).find(
    (el) => el.querySelector('.ed-row__name')?.textContent === title,
  ) as HTMLButtonElement

const rowList = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ed-row')).map((el) => ({
    title: el.querySelector('.ed-row__name')?.textContent ?? '',
    depth: Number(el.dataset.depth),
  }))

/** Перенос: pointerdown на источнике → pointermove на цели → pointerup. */
function drag(source: HTMLElement, target: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(source, { clientX: 20, clientY: 8, pointerId: 7, button: 0, pointerType: 'mouse' })
  fireEvent.pointerMove(target, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse' })
  fireEvent.pointerUp(target, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse' })
}

const parentIdOf = (events: Y.Array<Y.Map<unknown>>, id: unknown) => {
  const map = (events.toArray() as Y.Map<unknown>[]).find((m) => m.get('id') === id)
  return map ? yEventParentId(map) : undefined
}

describe('EditorsPanel — перетаскивание событий', () => {
  it('переносит под-событие на верхний уровень и в конец списка', () => {
    const { events, sub } = makeEvents()
    const onChanged = show(events)
    const subId = sub.get('id') as string

    const target = rowEl('Глава 2')
    placeRow(target, 100)
    // Левая часть и нижняя половина строки — «вставить после».
    drag(rowEl('Подсобытие'), target, 40, 125)

    expect(rowList()).toEqual([
      { title: 'Глава 1', depth: 0 },
      { title: 'Глава 2', depth: 0 },
      { title: 'Подсобытие', depth: 0 },
    ])
    expect(parentIdOf(events, subId)).toBeNull()
    expect(onChanged).toHaveBeenCalled()
  })

  it('вкладывает строку внутрь главы по правой части строки', () => {
    const { events, chapter2 } = makeEvents()
    const onChanged = show(events)
    const chapter2Id = chapter2.get('id') as string

    const target = rowEl('Глава 1')
    placeRow(target, 0)
    // Правая часть строки — зона «внутрь».
    drag(rowEl('Глава 2'), target, 180, 10)

    expect(rowList()).toEqual([
      { title: 'Глава 1', depth: 0 },
      { title: 'Подсобытие', depth: 1 },
      { title: 'Глава 2', depth: 1 },
    ])
    expect(parentIdOf(events, chapter2Id)).toBe(rowEl('Глава 1').dataset.eventId)
    expect(onChanged).toHaveBeenCalled()
  })

  it('запрещает вложить главу в собственное поддерево и показывает «нельзя»', () => {
    const { events, chapter1 } = makeEvents()
    const onChanged = show(events)
    const before = rowList()

    const target = rowEl('Подсобытие')
    placeRow(target, 100)
    fireEvent.pointerDown(rowEl('Глава 1'), {
      clientX: 20, clientY: 8, pointerId: 3, button: 0, pointerType: 'mouse',
    })
    fireEvent.pointerMove(target, { clientX: 180, clientY: 110, pointerId: 3, pointerType: 'mouse' })

    // Индикатор красный: класс is-blocked, и подсказка объясняет причину.
    expect(target.className).toContain('ed-row--drop-inside')
    expect(target.className).toContain('is-blocked')
    expect(screen.getByRole('status').textContent).toMatch(/собственное поддерево/)

    fireEvent.pointerUp(target, { clientX: 180, clientY: 110, pointerId: 3, pointerType: 'mouse' })
    expect(rowList()).toEqual(before)
    expect(parentIdOf(events, chapter1.get('id'))).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('сдвиг по своей же строке ничего не переносит и не показывает ошибку', () => {
    const { events, chapter1, sub } = makeEvents()
    const onChanged = show(events)
    const before = rowList()

    // Тянем под-событие вниз, но отпускаем в его же нижней половине: раньше это
    // читалось как «вложить в само себя» и человек видел ошибку там, где просто
    // не довёл строку до соседа.
    const self = rowEl('Подсобытие')
    placeRow(self, 100)
    drag(self, self, 40, 125)

    expect(rowList()).toEqual(before)
    expect(parentIdOf(events, sub.get('id'))).toBe(chapter1.get('id'))
    expect(onChanged).not.toHaveBeenCalled()
    expect(screen.queryByText(/само себя/)).toBeNull()
  })

  it('обычный клик без сдвига по-прежнему выбирает событие', () => {    const { events } = makeEvents()
    show(events)

    fireEvent.pointerDown(rowEl('Глава 2'), { clientX: 20, clientY: 8, pointerId: 5, button: 0 })
    fireEvent.pointerUp(rowEl('Глава 2'), { clientX: 20, clientY: 8, pointerId: 5 })
    fireEvent.click(rowEl('Глава 2'))

    expect(rowEl('Глава 2').className).toContain('ed-row--active')
  })

  it('Esc отменяет перенос, дерево не меняется', () => {
    const { events, sub } = makeEvents()
    const onChanged = show(events)
    const before = rowList()

    const target = rowEl('Глава 2')
    placeRow(target, 100)
    fireEvent.pointerDown(rowEl('Подсобытие'), {
      clientX: 20, clientY: 8, pointerId: 9, button: 0, pointerType: 'mouse',
    })
    fireEvent.pointerMove(target, { clientX: 40, clientY: 125, pointerId: 9 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(target, { clientX: 40, clientY: 125, pointerId: 9 })

    expect(rowList()).toEqual(before)
    expect(parentIdOf(events, sub.get('id'))).toBe((rowEl('Глава 1').dataset.eventId as string))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('переносит событие клавиатурой: Alt+↓ меняет порядок среди соседей', () => {
    const { events, chapter1, sub } = makeEvents()
    const onChanged = show(events)
    const chapter1Id = chapter1.get('id') as string
    const subId = sub.get('id') as string

    fireEvent.keyDown(rowEl('Глава 1'), { key: 'ArrowDown', altKey: true })

    expect(rowList()).toEqual([
      { title: 'Глава 2', depth: 0 },
      { title: 'Глава 1', depth: 0 },
      { title: 'Подсобытие', depth: 1 },
    ])
    // Глава 1 осталась корнем, под-событие поехало вместе с ней.
    expect(parentIdOf(events, chapter1Id)).toBeNull()
    expect(parentIdOf(events, subId)).toBe(chapter1Id)
    expect(onChanged).toHaveBeenCalled()
  })

  it('описывает перетаскивание и клавиши в подсказке строки', () => {
    const { events } = makeEvents()
    show(events)

    const row = rowEl('Глава 1')
    expect(row.getAttribute('aria-label')).toMatch(/Перетаскивание/)
    expect(row.getAttribute('aria-label')).toMatch(/Alt/)
    expect(row.getAttribute('title')).toMatch(/Alt/)
    // Ручка захвата — не текст для скринридера, а только цель для пальца.
    expect(row.querySelector('.ed-row__grip')?.getAttribute('aria-hidden')).toBe('true')
    expect(rowList().length).toBe(3)
  })
})
