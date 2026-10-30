import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { SelectionMenu } from './stage/SelectionMenu'
import { QuickEditWindow } from './stage/QuickEditWindow'
import { locateQuote, type QuoteEditRequest } from '../../lib/storySelection'
import { ensureText } from '../../collab/text'
import { setLang } from '../../store/lang'

/**
 * Выделение фрагмента в показе проекта (0.132.0).
 *
 * Проверяем три вещи, каждая из которых ломается независимо:
 *   1. `locateQuote` находит выделение в исходнике кадра — от точного совпадения до «по словам»,
 *      потому что показ рендерит Markdown и выделение приходит без разметки;
 *   2. меню появляется ТОЛЬКО для выделения внутри текста кадра и исчезает, когда выделение снято;
 *   3. три кнопки отправляют свои события с цитатой и смещениями, а окно быстрой правки пишет
 *      правку в документ именно по этим смещениям — и отказывается писать, если текст уехал.
 */

const SOURCE = 'Пролог\n\nАня вошла в дом. **Дом** стоял на холме.'

function selectIn(element: HTMLElement, text: string) {
  // Выделяем внутри текстового узла: смещение в элементе считается по дочерним узлам,
  // а не по символам, и такой Range был бы пустым.
  const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() as Text | null
  if (node === null) throw new Error('в элементе нет текста')
  const range = document.createRange()
  const index = node.textContent?.indexOf(text) ?? -1
  if (index < 0) throw new Error(`«${text}» нет в тексте элемента`)
  range.setStart(node, index)
  range.setEnd(node, index + text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

/** Дать отработать requestAnimationFrame, которым меню откладывает чтение выделения. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

afterEach(() => {
  cleanup()
  setLang('ru')
  window.getSelection()?.removeAllRanges()
})

beforeEach(() => {
  setLang('ru')
  // jsdom не считает геометрию (и в его Range такого метода просто нет): без этого выделение
  // всегда «нулевого размера», и меню справедливо не показывается. Подменяем только
  // прямоугольник — вся остальная логика остаётся настоящей.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 60,
      bottom: 30,
      width: 50,
      height: 10,
      toJSON: () => ({}),
    }),
  })
})

describe('locateQuote', () => {
  it('находит точное совпадение', () => {
    expect(locateQuote(SOURCE, 'Аня вошла в дом.')).toEqual({ from: 8, to: 24 })
  })

  it('находит выделение, между словами которого в исходнике стоит разметка', () => {
    // В исходнике `**Дом** стоял`, в показе — «Дом стоял»: точного совпадения нет.
    const range = locateQuote(SOURCE, 'Дом стоял на холме.')
    expect(range).not.toBeNull()
    expect(SOURCE.slice(range!.from, range!.to)).toBe('Дом** стоял на холме')
  })

  it('находит выделение через перевод строки', () => {
    const range = locateQuote('Первая строка\nвторая строка', 'Первая строка вторая строка')
    expect(range).not.toBeNull()
    expect(range!.from).toBe(0)
  })

  it('находит выделение с середины слова', () => {
    const range = locateQuote('**вошла** в дом', 'ошла в дом')
    expect(range).not.toBeNull()
    expect(range!.to - range!.from).toBe('ошла** в дом'.length)
  })

  it('не находит то, чего в кадре нет', () => {
    expect(locateQuote(SOURCE, 'Совсем другой текст')).toBeNull()
  })

  it('пустое выделение не ищет', () => {
    expect(locateQuote(SOURCE, '   ')).toBeNull()
  })
})

describe('SelectionMenu', () => {
  function mount() {
    const view = render(
      <div>
        <div data-frame-body="f1">
          <p>Аня вошла в дом и огляделась.</p>
        </div>
        <SelectionMenu frameId="f1" frameTitle="Пролог" source={SOURCE} />
      </div>,
    )
    const body = view.container.querySelector('[data-frame-body="f1"]') as HTMLElement
    return { view, body }
  }

  it('на выделении в тексте кадра показывает три действия', async () => {
    const { body } = mount()
    selectIn(body, 'вошла в дом')

    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'В чат проекта' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Спросить помощника' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Редактировать фрагмент' })).toBeTruthy()
  })

  it('«в чат проекта» отправляет цитату со смещениями в исходнике', async () => {
    const handler = vi.fn()
    window.addEventListener('skyfraze:quote-to-chat', handler)
    const { body } = mount()
    selectIn(body, 'вошла в дом')
    await waitFor(() => expect(screen.getByRole('button', { name: 'В чат проекта' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'В чат проекта' }))

    expect(handler).toHaveBeenCalledTimes(1)
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail
    expect(detail).toMatchObject({ frameId: 'f1', frameTitle: 'Пролог', quote: 'вошла в дом' })
    // Смещения посчитаны по исходнику кадра, а не по тексту в DOM.
    expect(SOURCE.slice(detail.range.from, detail.range.to)).toBe('вошла в дом')
    window.removeEventListener('skyfraze:quote-to-chat', handler)
  })

  it('«помощнику» и «править» — свои события', async () => {
    const assistant = vi.fn()
    const edit = vi.fn()
    window.addEventListener('skyfraze:quote-to-assistant', assistant)
    window.addEventListener('skyfraze:quote-edit', edit)
    const { body } = mount()

    selectIn(body, 'огляделась')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Спросить помощника' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Спросить помощника' }))
    expect(assistant).toHaveBeenCalledTimes(1)

    selectIn(body, 'вошла в дом')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Редактировать фрагмент' })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Редактировать фрагмент' }))
    expect(edit).toHaveBeenCalledTimes(1)
    // Окно правки получает nonce: по нему оно понимает, что просят другой фрагмент.
    expect((edit.mock.calls[0][0] as CustomEvent).detail.nonce).toBeTypeOf('number')

    window.removeEventListener('skyfraze:quote-to-assistant', assistant)
    window.removeEventListener('skyfraze:quote-edit', edit)
  })

  it('выделение вне текста кадра меню не показывает', async () => {
    const view = render(
      <div>
        <div data-frame-body="f1">
          <p>Аня вошла в дом.</p>
        </div>
        <p id="outside">Подпись вне кадра</p>
        <SelectionMenu frameId="f1" frameTitle="Пролог" source={SOURCE} />
      </div>,
    )
    const outside = view.container.querySelector('#outside') as HTMLElement
    selectIn(outside, 'Подпись')
    await settle()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('Escape закрывает меню', async () => {
    const { body } = mount()
    selectIn(body, 'вошла в дом')
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull())
  })

  it('на английском подписи меню переведены', async () => {
    setLang('en')
    const { body } = mount()
    selectIn(body, 'вошла в дом')
    await waitFor(() => expect(screen.getByRole('toolbar')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'To the project chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask the assistant' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit the fragment' })).toBeTruthy()
  })
})

describe('QuickEditWindow', () => {
  /** Кадр с текстом в CRDT: тот же путь, что у редакторов (`ensureText` мигрирует строку). */
  function makeFrame(body: string) {
    const doc = new Y.Doc()
    const map = new Y.Map<unknown>()
    doc.getMap('events').set('f1', map)
    map.set('id', 'f1')
    map.set('body', body)
    return map
  }

  function request(body: string, quote: string): QuoteEditRequest {
    const range = locateQuote(body, quote)
    return { frameId: 'f1', frameTitle: 'Пролог', quote, range, nonce: 1 }
  }

  const bodyOf = (map: Y.Map<unknown>) => ensureText(map, 'body').toString()

  it('сохраняет правку в документ кадра по найденным смещениям', async () => {
    const map = makeFrame('Аня вошла в дом и огляделась.')
    const onClose = vi.fn()
    render(
      <QuickEditWindow
        request={request(bodyOf(map), 'вошла в дом')}
        ymap={map}
        onClose={onClose}
        onOpenEditors={() => {}}
      />,
    )

    const field = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(field.value).toBe('вошла в дом')
    fireEvent.change(field, { target: { value: 'вошла в избу' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(bodyOf(map)).toBe('Аня вошла в избу и огляделась.'))
    expect(screen.getByRole('status').textContent).toBe('Фрагмент сохранён.')
  })

  it('не пишет поверх чужой правки: текст на месте смещений уже другой', async () => {
    const map = makeFrame('Аня вошла в дом и огляделась.')
    const req = request(bodyOf(map), 'вошла в дом')
    render(
      <QuickEditWindow request={req} ymap={map} onClose={() => {}} onOpenEditors={() => {}} />,
    )

    // Соавтор переписал абзац, пока окно было открыто.
    ensureText(map, 'body').delete(0, 4)
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/не нашёлся/))
    expect(bodyOf(map)).toBe('вошла в дом и огляделась.')
  })

  it('без смещений честно говорит, что фрагмент не найден, и ведёт в редакторы', async () => {
    const map = makeFrame('Аня вошла в дом.')
    const onOpenEditors = vi.fn()
    render(
      <QuickEditWindow
        request={{ frameId: 'f1', frameTitle: 'Пролог', quote: 'нет такого', range: null, nonce: 2 }}
        ymap={map}
        onClose={() => {}}
        onOpenEditors={onOpenEditors}
      />,
    )

    expect(screen.getByText(/не нашёлся в исходном тексте кадра/)).toBeTruthy()
    // Править нечего — кнопки «Сохранить» нет, а уйти в редакторы можно.
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть в редакторах' }))
    expect(onOpenEditors).toHaveBeenCalledTimes(1)
  })

  it('пустое поле не сохраняется', async () => {
    const map = makeFrame('Аня вошла в дом.')
    render(
      <QuickEditWindow
        request={request(bodyOf(map), 'вошла в дом')}
        ymap={map}
        onClose={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/править нечего/))
    expect(bodyOf(map)).toBe('Аня вошла в дом.')
  })

  it('на английском окно переведено', async () => {
    setLang('en')
    const map = makeFrame('Аня вошла в дом.')
    render(
      <QuickEditWindow
        request={request(bodyOf(map), 'вошла в дом')}
        ymap={map}
        onClose={() => {}}
        onOpenEditors={() => {}}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Quick fragment edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in the editors' })).toBeTruthy()
  })
})
