import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { anchorStatus, anchorText, encodeAnchor, resolveAnchor } from './anchors'

/**
 * Якоря замечаний к фрагменту.
 *
 * Проверяем не «функция вернула объект», а обещание: замечание остаётся на том же тексте
 * после чужих правок и честно сообщает, когда фрагмента больше нет. Именно на этом ломается
 * наивное решение «смещение в символах» — оно продолжает выглядеть валидным, указывая на
 * другой текст (docs/fragment-comments.md §4).
 */

let doc: Y.Doc
let text: Y.Text

function seeded(body: string): void {
  doc = new Y.Doc()
  text = doc.getText('body')
  doc.transact(() => {
    text.insert(0, body)
  })
}

beforeEach(() => {
  seeded('Первый абзац.\nВторой абзац.\nТретий абзац.')
})

function anchorOf(quote: string, from?: number) {
  const content = text.toString()
  const start = from ?? content.indexOf(quote)
  const encoded = encodeAnchor(text, start, start + quote.length)
  if (!encoded) throw new Error('якорь не создан')
  return { field: 'body', ...encoded }
}

describe('encodeAnchor / resolveAnchor', () => {
  it('ставит якорь на фрагмент и возвращает тот же диапазон', () => {
    const anchor = anchorOf('Второй абзац.')
    expect(anchor.quote).toBe('Второй абзац.')
    expect(anchor.field).toBe('body')
    // Позиции — base64 от Y.encodeRelativePosition, а не «число в строке».
    expect(typeof anchor.start).toBe('string')
    expect(resolveAnchor(text, anchor)).toEqual({
      from: text.toString().indexOf('Второй абзац.'),
      to: text.toString().indexOf('Второй абзац.') + 'Второй абзац.'.length,
    })
  })

  it('не создаёт якорь на пустой диапазон', () => {
    expect(encodeAnchor(text, 5, 5)).toBeNull()
    expect(encodeAnchor(text, 9, 3)).not.toBeNull() // обратный диапазон нормализуется
  })

  it('переживает вставку до фрагмента — то, на чём ломается смещение в символах', () => {
    const anchor = anchorOf('Второй абзац.')
    const before = text.toString().indexOf('Второй абзац.')

    doc.transact(() => {
      text.insert(0, 'Новое начало.\n')
    })

    const range = resolveAnchor(text, anchor)
    expect(range).not.toBeNull()
    expect(range!.from).toBe(before + 'Новое начало.\n'.length)
    expect(anchorText(text, anchor)).toBe('Второй абзац.')
  })

  it('переживает вставку сразу после фрагмента, не расширяясь', () => {
    const anchor = anchorOf('Второй абзац.')
    const to = text.toString().indexOf('Второй абзац.') + 'Второй абзац.'.length

    doc.transact(() => {
      text.insert(to, ' Дописано.')
    })

    expect(anchorText(text, anchor)).toBe('Второй абзац.')
    expect(resolveAnchor(text, anchor)!.to).toBe(to)
  })

  it('фрагмент удалён — якорь схлопнулся, а не «пропал»', () => {
    const anchor = anchorOf('Второй абзац.')
    const range = resolveAnchor(text, anchor)!
    doc.transact(() => {
      text.delete(range.from, range.to - range.from)
    })

    expect(anchorStatus(text, anchor)).toBe('collapsed')
    expect(anchorText(text, anchor)).toBe('')
  })

  it('текст переписан целиком — фрагмента больше нет (у клиента это collapsed)', () => {
    const anchor = anchorOf('Второй абзац.')
    doc.transact(() => {
      text.delete(0, text.length)
      text.insert(0, 'Совсем другой текст.')
    })

    // Измерено: Yjs резолвит якорь через «надгробия» удалённых элементов и отдаёт пустой
    // диапазон, то есть collapsed. ygo на той же операции возвращает «не резолвится»
    // (docs/fragment-comments.md §4). Для человека это одно и то же — фрагмента нет, — но
    // серверная проверка правок обязана опираться на текст спана, а не на этот статус.
    const status = anchorStatus(text, anchor)
    expect(['collapsed', 'orphan']).toContain(status)
    expect(anchorText(text, anchor)).toBe('')
  })

  it('емодзи считаются единицами UTF-16: диапазон после эмодзи не съезжает', () => {
    seeded('🦔 Ёжик.\nВторой абзац.')
    const quote = 'Второй абзац.'
    const anchor = anchorOf(quote)

    // Эмодзи занимает две единицы UTF-16; если бы считали руны, границы разошлись бы.
    expect(anchorText(text, anchor)).toBe(quote)
    doc.transact(() => {
      text.insert(0, '🦔 ')
    })
    expect(anchorText(text, anchor)).toBe(quote)
  })

  it('битый якорь — orphan, а не падение', () => {
    expect(anchorStatus(text, { field: 'body', start: 'не base64!', end: 'тоже', quote: 'x' })).toBe('orphan')
    expect(anchorStatus(text, { field: 'body', start: '', end: '', quote: 'x' })).toBe('orphan')
  })
})
