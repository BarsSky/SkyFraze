import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { yAddEvent } from '../../collab/yprovider'
import type { MarkdownImportPreview } from '../../api/storyFiles'
import { EditorsPanel } from './EditorsPanel'

/**
 * Импорт куска md «в место».
 *
 * Проверяем то, что видит человек: файлы разбираются СЕРВЕРОМ (сеть подменена),
 * разобранный кусок показывается подписью, его можно перетащить на строку дерева
 * (левая часть строки — между событиями, правая — внутрь) или вставить по
 * выбранному месту списком. Отдельно закреплено, что слишком глубокий кусок
 * серверу не отправляется: дерево глубже 4 уровней он отвергнет.
 */

const mocks = vi.hoisted(() => ({ preview: vi.fn(), errorText: vi.fn() }))

vi.mock('../../api/storyFiles', () => ({
  previewMarkdownImport: mocks.preview,
  readImportErrorMessage: mocks.errorText,
}))

// Редактор события тянет за собой markdown-it/katex/mermaid — здесь он не нужен.
vi.mock('./EventEditor', () => ({ EventEditor: () => null }))

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

beforeAll(() => {
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent
})

afterEach(() => cleanup())

beforeEach(() => {
  mocks.preview.mockReset()
  mocks.errorText.mockReset()
  mocks.errorText.mockResolvedValue(null)
})

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
  return { events, chapter1, sub, chapter2 }
}

function show(
  events: Y.Array<Y.Map<unknown>>,
  onImportInto = vi.fn().mockResolvedValue({ projectId: 'p1', events: 2, warnings: [] }),
) {
  render(
    <EditorsPanel
      events={events}
      assets={[]}
      assetUrls={{}}
      onChanged={vi.fn()}
      onUpload={async () => null}
      onImportInto={onImportInto}
    />,
  )
  return onImportInto
}

/** Кусок из двух уровней: глава и её под-событие. */
const chunk: MarkdownImportPreview = {
  projectTitle: 'Часть',
  events: [
    { number: '02', depth: 0, title: 'Вставка', path: '02-Вставка.md', chars: 10, warnings: [] },
    { number: '02.1', depth: 1, title: 'Шаг', path: '02.1-Шаг.md', chars: 5, warnings: [] },
  ],
  warnings: [],
  stats: { files: 2, events: 2, chars: 15, imageLinks: 0 },
}

const rowEl = (title: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.ed-row')).find(
    (el) => el.querySelector('.ed-row__name')?.textContent === title,
  ) as HTMLButtonElement

/** Выбор zip: папку в jsdom не собрать (нет webkitRelativePath). */
function pickZip() {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.ed-import input[type="file"]'))
  fireEvent.change(inputs[1], { target: { files: [new File(['PK'], 'часть.zip')] } })
}

/** Разбор файлов и появление куска. */
async function loadChunk(preview: MarkdownImportPreview = chunk) {
  mocks.preview.mockResolvedValue(preview)
  pickZip()
  return screen.findByText(/часть\.zip/)
}

/** Перетаскивание куска: pointerdown на чипе → pointermove на строке → pointerup. */
function dragChunk(target: HTMLElement, x: number, y: number) {
  const chip = document.querySelector<HTMLElement>('[data-ed-chunk]') as HTMLElement
  fireEvent.pointerDown(chip, { clientX: 20, clientY: 8, pointerId: 9, button: 0, pointerType: 'mouse' })
  fireEvent.pointerMove(target, { clientX: x, clientY: y, pointerId: 9, pointerType: 'mouse' })
  fireEvent.pointerUp(target, { clientX: x, clientY: y, pointerId: 9, pointerType: 'mouse' })
}

describe('EditorsPanel — импорт куска md «в место»', () => {
  it('без колбэка импорта строки выбора файлов нет', () => {
    const { events } = makeEvents()
    render(
      <EditorsPanel events={events} assets={[]} assetUrls={{}} onChanged={vi.fn()} onUpload={async () => null} />,
    )
    expect(document.querySelector('[data-ed-import]')).toBeNull()
  })

  it('разбирает выбранный zip и показывает кусок словами человека', async () => {
    const { events } = makeEvents()
    show(events)

    await loadChunk()

    expect(mocks.preview).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-ed-chunk]')?.textContent).toContain('2 события')
    // Пока место не выбрано, в проект ничего не пишется.
    expect(screen.getByRole('button', { name: 'вставить' })).toBeInTheDocument()
  })

  it('перетаскивание в нижнюю половину строки вставляет кусок после неё', async () => {
    const { events, chapter2 } = makeEvents()
    const onImportInto = show(events)
    await loadChunk()

    const target = rowEl('Глава 2')
    placeRow(target, 100)
    dragChunk(target, 40, 125) // левая часть и нижняя половина — «после»

    await waitFor(() => expect(onImportInto).toHaveBeenCalledTimes(1))
    expect(onImportInto.mock.calls[0][1]).toEqual({ parentId: null, afterId: chapter2.get('id') })
    // Кусок после вставки из панели исчезает: он уже в проекте.
    await waitFor(() => expect(document.querySelector('[data-ed-chunk]')).toBeNull())
  })

  it('перетаскивание в правую часть строки вкладывает кусок внутрь — последним ребёнком', async () => {
    const { events, chapter1, sub } = makeEvents()
    const onImportInto = show(events)
    await loadChunk()

    const target = rowEl('Глава 1')
    placeRow(target, 100)
    dragChunk(target, 190, 110) // правая часть строки — «внутрь»

    await waitFor(() => expect(onImportInto).toHaveBeenCalledTimes(1))
    expect(onImportInto.mock.calls[0][1]).toEqual({
      parentId: chapter1.get('id'),
      afterId: sub.get('id'),
    })
  })

  it('слишком глубокий кусок внутрь под-события не отправляется', async () => {
    const { events } = makeEvents()
    const onImportInto = show(events)
    // Четыре уровня в куске: внутрь под-события (глубина 1) это уже 5 уровней.
    await loadChunk({
      ...chunk,
      events: [
        { number: '01', depth: 0, title: 'A', path: '01-A.md', chars: 1, warnings: [] },
        { number: '01.1', depth: 1, title: 'B', path: '01.1-B.md', chars: 1, warnings: [] },
        { number: '01.1.1', depth: 2, title: 'C', path: '01.1.1-C.md', chars: 1, warnings: [] },
        { number: '01.1.1.1', depth: 3, title: 'D', path: '01.1.1.1-D.md', chars: 1, warnings: [] },
      ],
    })

    const target = rowEl('Подсобытие')
    placeRow(target, 100)
    dragChunk(target, 190, 110)

    await waitFor(() => expect(screen.getByText(/Сюда нельзя/)).toBeInTheDocument())
    expect(onImportInto).not.toHaveBeenCalled()
    // Кусок остаётся в панели: место можно выбрать другое.
    expect(document.querySelector('[data-ed-chunk]')).not.toBeNull()
  })

  it('место можно выбрать списком — для клавиатуры и тача', async () => {
    const { events, chapter1, sub } = makeEvents()
    const onImportInto = show(events)
    await loadChunk()

    // Первая строка выбирается сама — это «Глава 1».
    fireEvent.change(screen.getByLabelText('Место вставки куска'), { target: { value: 'after' } })
    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))

    await waitFor(() => expect(onImportInto).toHaveBeenCalledTimes(1))
    expect(onImportInto.mock.calls[0][1]).toEqual({ parentId: null, afterId: chapter1.get('id') })

    // «Внутрь выбранного» — тоже последним ребёнком.
    await loadChunk()
    fireEvent.change(screen.getByLabelText('Место вставки куска'), { target: { value: 'inside' } })
    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))
    await waitFor(() => expect(onImportInto).toHaveBeenCalledTimes(2))
    expect(onImportInto.mock.calls[1][1]).toEqual({
      parentId: chapter1.get('id'),
      afterId: sub.get('id'),
    })
  })

  it('«в конец проекта» вставляет без места: сервер допишет в конец', async () => {
    const { events } = makeEvents()
    const onImportInto = show(events)
    await loadChunk()

    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))

    await waitFor(() => expect(onImportInto).toHaveBeenCalledTimes(1))
    expect(onImportInto.mock.calls[0][1]).toEqual({})
  })

  it('ошибку сервера показывает его словами и кусок не теряет', async () => {
    const { events } = makeEvents()
    const onImportInto = vi.fn().mockRejectedValue(new Error('boom'))
    show(events, onImportInto)
    mocks.errorText.mockResolvedValue('слишком много файлов: больше 2000')
    await loadChunk()

    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))

    expect(await screen.findByText('слишком много файлов: больше 2000')).toBeInTheDocument()
    expect(document.querySelector('[data-ed-chunk]')).not.toBeNull()
  })

  it('предупреждение сервера показывается рядом с числом вставленных событий', async () => {
    const { events } = makeEvents()
    const onImportInto = vi.fn().mockResolvedValue({
      projectId: 'p1',
      events: 2,
      warnings: ['кусок вставлен, но таблица событий не перестроена'],
    })
    show(events, onImportInto)
    await loadChunk()

    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))

    // Вставка сделана — кусок из панели уходит, но человек видит, что копия отстала.
    expect(await screen.findByText(/Вставлено событий: 2/)).toBeInTheDocument()
    expect(screen.getByText(/таблица событий не перестроена/)).toBeInTheDocument()
    expect(document.querySelector('[data-ed-chunk]')).toBeNull()
  })

  it('отказ 503 (документ проекта грузится) оставляет кусок для повтора', async () => {
    const { events } = makeEvents()
    const onImportInto = vi.fn().mockRejectedValue(new Error('busy'))
    show(events, onImportInto)
    mocks.errorText.mockResolvedValue('документ проекта загружается, повторите запрос через секунду')
    await loadChunk()

    fireEvent.click(screen.getByRole('button', { name: 'вставить' }))

    expect(await screen.findByText(/повторите запрос через секунду/)).toBeInTheDocument()
    // Ничего не вставлено, кусок на месте: повтор — один клик.
    expect(document.querySelector('[data-ed-chunk]')).not.toBeNull()
  })
})
