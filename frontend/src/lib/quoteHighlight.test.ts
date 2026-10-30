import { afterEach, describe, expect, it, vi } from 'vitest'
import { findQuoteRange, highlightQuote, QUOTE_HIGHLIGHT } from './quoteHighlight'

/**
 * Подсветка фразы в показе проекта (0.133.0).
 *
 * Проверяем то, что ломается независимо:
 *   1. фраза находится в ОТРИСОВАННОМ тексте — в том числе когда в исходнике была разметка
 *      (в показе её уже нет) и когда фраза разорвана на несколько текстовых узлов;
 *   2. фразы нет — диапазона нет: подсветить «примерно там» нельзя, человек решит, что обсуждали
 *      не то;
 *   3. подсветка снимается (и не оставляет мусора в тексте);
 *   4. когда браузер умеет CSS Custom Highlight API, DOM не трогается вовсе — разметку кадра
 *      держит React, и лишние узлы в ней ломают сверку.
 */

function mount(html: string): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('findQuoteRange', () => {
  it('находит фразу внутри абзаца', () => {
    const root = mount('<p>Аня вошла в дом и огляделась.</p>')
    const range = findQuoteRange(root, 'вошла в дом')
    expect(range).not.toBeNull()
    expect(range!.toString()).toBe('вошла в дом')
  })

  it('находит фразу, разорванную разметкой на несколько узлов', () => {
    // В исходнике `**дом**`, в показе — <strong>: одно слово, но три текстовых узла.
    const root = mount('<p>Аня вошла в <strong>дом</strong> и огляделась.</p>')
    const range = findQuoteRange(root, 'вошла в дом и огляделась')
    expect(range).not.toBeNull()
    // Диапазон начинается до <strong> и кончается после него: фраза не обрывается на разметке.
    expect(range!.toString()).toBe('вошла в дом и огляделась')
  })

  it('находит фразу через абзацы (блоки не склеиваются в одно слово)', () => {
    const root = mount('<p>Первая строка</p><p>вторая строка</p>')
    const range = findQuoteRange(root, 'Первая строка вторая строка')
    expect(range).not.toBeNull()
  })

  it('не находит то, чего в кадре нет', () => {
    const root = mount('<p>Аня вошла в дом.</p>')
    expect(findQuoteRange(root, 'Совсем другой текст')).toBeNull()
  })

  it('пустая фраза не ищется', () => {
    const root = mount('<p>Аня вошла в дом.</p>')
    expect(findQuoteRange(root, '   ')).toBeNull()
  })
})

describe('highlightQuote', () => {
  it('в среде без CSS Highlight API оборачивает найденное в <mark> и снимает его', () => {
    const root = mount('<p>Аня вошла в дом и огляделась.</p>')
    const applied = highlightQuote(root, 'вошла в дом')
    expect(applied.found).toBe(true)
    const mark = root.querySelector('[data-quote-mark]')
    expect(mark).not.toBeNull()
    expect(mark!.textContent).toBe('вошла в дом')

    applied.clear()
    expect(root.querySelector('[data-quote-mark]')).toBeNull()
    // Текст восстановлен целиком: подсветка не съела ни буквы.
    expect(root.textContent).toBe('Аня вошла в дом и огляделась.')
  })

  it('без находки подсветки нет и снятие безопасно', () => {
    const root = mount('<p>Аня вошла в дом.</p>')
    const applied = highlightQuote(root, 'Совсем другой текст')
    expect(applied.found).toBe(false)
    expect(() => applied.clear()).not.toThrow()
    expect(root.querySelector('[data-quote-mark]')).toBeNull()
  })

  it('когда браузер умеет Highlight API, DOM не трогается', () => {
    const set = vi.fn()
    const remove = vi.fn(() => true)
    vi.stubGlobal('CSS', { highlights: { set, delete: remove } })
    class FakeHighlight {
      constructor(public ranges: Range[]) {}
    }
    vi.stubGlobal('Highlight', FakeHighlight)

    const root = mount('<p>Аня вошла в дом.</p>')
    const html = root.innerHTML
    const applied = highlightQuote(root, 'вошла в дом')

    expect(applied.found).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    expect(set.mock.calls[0][0]).toBe(QUOTE_HIGHLIGHT)
    // Разметка кадра та же: подсветка живёт в реестре, а не в DOM.
    expect(root.innerHTML).toBe(html)

    applied.clear()
    expect(remove).toHaveBeenCalledWith(QUOTE_HIGHLIGHT)
  })
})
