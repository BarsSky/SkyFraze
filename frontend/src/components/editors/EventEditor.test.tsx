import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as Y from 'yjs'
import { EventEditor } from './EventEditor'
import { ensureText } from '../../collab/text'
import { setLang } from '../../store/lang'

/**
 * «Показать в проекте» (0.133.0): обратный переход из редакторов.
 *
 * Правя абзац, человек хочет увидеть его в кадре — с тем же выделенным куском. Проверяем обе
 * половины: с выделением уезжает цитата, без выделения — только кадр. Сама подсветка в показе
 * проверяется тестами `CopyPanel` и `quoteHighlight`, а переход между вкладками — e2e-сценарием.
 *
 * Тяжёлые части редактора подменены: markdown-it/katex/mermaid для этой проверки не нужны.
 */

vi.mock('../MarkdownBlock', () => ({
  MarkdownBlock: ({ source }: { source: string }) => <p data-markdown>{source}</p>,
}))
vi.mock('../MarkdownEditor', () => ({ MarkdownEditor: () => null }))
vi.mock('./BackgroundPicker', () => ({ BackgroundPicker: () => null }))

function frame(body: string) {
  const doc = new Y.Doc()
  const map = new Y.Map<unknown>()
  doc.getMap('events').set('e1', map)
  map.set('id', 'f1')
  map.set('title', 'Пролог')
  map.set('body', body)
  return map
}

const renderEditor = (body: string, onShowInProject: (quote?: string) => void) =>
  render(
    <EventEditor
      ymap={frame(body)}
      assets={[]}
      images={[]}
      assetUrls={{}}
      background={{ kind: 'inherit' }}
      onUpload={async () => null}
      onUploadMany={async () => undefined}
      onAttach={() => {}}
      onDetach={() => {}}
      onBackgroundChange={() => {}}
      onChange={() => {}}
      onShowInProject={onShowInProject}
    />,
  )

/** Выделить кусок в поле текста: кнопка берёт выделение из него. */
function selectBody(text: string) {
  const body = screen.getByPlaceholderText(/Разметка/i) as HTMLTextAreaElement
  const from = body.value.indexOf(text)
  expect(from, `«${text}» должно быть в тексте кадра`).toBeGreaterThanOrEqual(0)
  body.setSelectionRange(from, from + text.length)
  fireEvent.select(body)
  return body
}

afterEach(() => {
  cleanup()
  setLang('ru')
})

describe('EventEditor — «Показать в проекте»', () => {
  it('передаёт выделенный кусок как цитату', () => {
    setLang('ru')
    const onShowInProject = vi.fn()
    renderEditor('Аня вошла в дом и огляделась.', onShowInProject)
    selectBody('вошла в дом')
    fireEvent.click(screen.getByRole('button', { name: 'Показать в проекте' }))
    expect(onShowInProject).toHaveBeenCalledWith('вошла в дом')
  })

  it('без выделения открывает кадр целиком', () => {
    const onShowInProject = vi.fn()
    renderEditor('Аня вошла в дом.', onShowInProject)
    fireEvent.click(screen.getByRole('button', { name: 'Показать в проекте' }))
    expect(onShowInProject).toHaveBeenCalledWith(undefined)
  })

  it('на английском кнопка переведена', () => {
    setLang('en')
    renderEditor('Аня вошла в дом.', () => {})
    expect(screen.getByRole('button', { name: 'Show in the project' })).toBeTruthy()
  })
})
