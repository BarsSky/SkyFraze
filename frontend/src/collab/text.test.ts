import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyLocalEdit,
  ensureText,
  migrateTextFields,
  setText,
  textDiff,
  textString,
  titleString,
  type YMap,
} from './text'

/**
 * Текст события как `Y.Text`. Проверяется три вещи: старая строка не теряется и
 * не переписывается, правка идёт минимальным дифом (а не перезаписью целого
 * значения), а одновременный набор двух авторов сохраняется у обоих — ради этого
 * фаза и делалась.
 */
function makeDoc() {
  const doc = new Y.Doc()
  const events = doc.getArray<YMap>('events')
  return { doc, events }
}

function addEvent(events: Y.Array<YMap>, fields: Record<string, unknown> = {}) {
  const map = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(fields)) map.set(k, v)
  events.push([map])
  return map
}

describe('чтение текста', () => {
  it('пока Y.Text нет, читается старая строка — без изменения документа', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { title: 'Глава', body: 'Текст главы' })
    expect(textString(map, 'title')).toBe('Глава')
    expect(textString(map, 'body')).toBe('Текст главы')
    expect(titleString(map)).toBe('Глава')
    // Чтение ничего не создаёт: страница только для чтения не правит документ.
    expect(map.get('title_text')).toBeUndefined()
    expect(map.get('body_text')).toBeUndefined()
  })

  it('созданный Y.Text становится источником, а старая строка — историей', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { title: 'Глава', body: 'Текст' })
    ensureText(map, 'body')
    expect(textString(map, 'body')).toBe('Текст')
    // Правим только текст: старая строка остаётся прежней.
    setText(map, 'body', 'Текст с правкой')
    expect(textString(map, 'body')).toBe('Текст с правкой')
    expect(map.get('body')).toBe('Текст')
  })

  it('пустое событие читается пустой строкой, из мусора не падаем', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { title: 42, body: null })
    expect(textString(map, 'title')).toBe('')
    expect(textString(map, 'body')).toBe('')
  })
})

describe('правка текста', () => {
  it('диф оставляет минимум работы: набор в конце — одна вставка', () => {
    expect(textDiff('Глава', 'Глава 1')).toEqual({ index: 5, remove: 0, insert: ' 1' })
    expect(textDiff('Глава 1', 'Глава')).toEqual({ index: 5, remove: 2, insert: '' })
    expect(textDiff('abc', 'axc')).toEqual({ index: 1, remove: 1, insert: 'x' })
    expect(textDiff('одинаково', 'одинаково')).toEqual({ index: 0, remove: 0, insert: '' })
    expect(textDiff('', 'текст')).toEqual({ index: 0, remove: 0, insert: 'текст' })
  })

  it('setText применяет диф, а не перезапись целого значения', () => {
    const { doc, events } = makeDoc()
    const map = addEvent(events, { body: 'Начало' })
    ensureText(map, 'body')
    let updates = 0
    doc.on('update', () => {
      updates += 1
    })
    setText(map, 'body', 'Начало и конец')
    expect(textString(map, 'body')).toBe('Начало и конец')
    // Один апдейт на одну правку: перезапись через set дала бы удаление+вставку
    // всего текста и рост снапшота на каждое нажатие.
    expect(updates).toBe(1)

    // Повтор того же значения ничего не пишет.
    updates = 0
    setText(map, 'body', 'Начало и конец')
    expect(updates).toBe(0)
  })

  it('правка на пустом событии создаёт текст сразу с содержимым', () => {
    const { events } = makeDoc()
    const map = addEvent(events)
    setText(map, 'title', 'Новая глава')
    expect(textString(map, 'title')).toBe('Новая глава')
    expect(map.get('title_text')).toBeInstanceOf(Y.Text)
  })
})

describe('одновременный набор двух авторов', () => {
  it('вставки в разных местах сохраняются обе (ради этого и вводился Y.Text)', () => {
    const left = makeDoc()
    const right = makeDoc()
    const startLeft = addEvent(left.events, { body: 'Общее начало' })
    ensureText(startLeft, 'body')
    // Второй автор получает то же состояние через обычный апдейт CRDT.
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))
    const startRight = right.events.get(0) as YMap

    setText(startLeft, 'body', 'Общее начало (правка Ани)')
    setText(startRight, 'body', 'Общее начало (правка Бориса)')

    Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right.doc))
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))

    const merged = textString(left.events.get(0) as YMap, 'body')
    expect(textString(right.events.get(0) as YMap, 'body')).toBe(merged)
    expect(merged).toContain('правка Ани')
    expect(merged).toContain('правка Бориса')
    expect(merged).toContain('Общее начало')
  })

  it('две одновременные миграции дают один текст и общий исходный смысл', () => {
    const left = makeDoc()
    const right = makeDoc()
    addEvent(left.events, { title: 'Глава первая', body: 'Текст' })
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))

    // Оба клиента мигрируют одно и то же событие, не видя друг друга.
    expect(migrateTextFields(left.events)).toBe(2)
    expect(migrateTextFields(right.events)).toBe(2)
    Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right.doc))
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))

    const onLeft = textString(left.events.get(0) as YMap, 'body')
    const onRight = textString(right.events.get(0) as YMap, 'body')
    // LWW выбрал одну ветку — одинаковую на обоих клиентах, и текст не удвоился.
    expect(onLeft).toBe(onRight)
    expect(onLeft).toBe('Текст')
  })

  it('миграция идемпотентна: второй прогон ничего не делает', () => {
    const { events } = makeDoc()
    addEvent(events, { title: 'Глава', body: 'Текст' })
    expect(migrateTextFields(events)).toBe(2)
    expect(migrateTextFields(events)).toBe(0)
    expect(textString(events.get(0) as YMap, 'title')).toBe('Глава')
  })

  it('миграция не трогает событие без текстовых полей', () => {
    const { events } = makeDoc()
    addEvent(events, { bg_kind: 'tone' })
    expect(migrateTextFields(events)).toBe(0)
  })
})

describe('локальная правка при чужой вставке рядом', () => {
  it('чужая вставка перед нашей не стирается и сдвигает нашу', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { body: 'конец' })
    const text = ensureText(map, 'body')
    // В CRDT уже приехала чужая правка, а в поле у человека её ещё нет.
    text.insert(0, 'начало ')
    applyLocalEdit(text, 'конец', 'конецX', 'начало конец')
    expect(textString(map, 'body')).toBe('начало конецX')
  })

  it('чужая вставка после нашей позиции ничего не сдвигает', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { body: 'конец' })
    const text = ensureText(map, 'body')
    text.insert(text.length, ' (чужое)')
    applyLocalEdit(text, 'конец', 'Xконец', 'конец (чужое)')
    expect(textString(map, 'body')).toBe('Xконец (чужое)')
  })

  it('набор в конце не превращает чужую вставку в удаление', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { body: 'текст.' })
    const text = ensureText(map, 'body')
    text.insert(text.length, 'Б')
    applyLocalEdit(text, 'текст.', 'текст.А', 'текст.Б')
    const result = textString(map, 'body')
    expect(result).toContain('Б')
    expect(result).toContain('А')
  })

  it('удаление стирает только то, что реально совпадает', () => {
    const { events } = makeDoc()
    const map = addEvent(events, { body: 'кот и пёс' })
    const text = ensureText(map, 'body')
    // Чужой апдейт переписал текст, а человек в это время стёр «кот ».
    setText(map, 'body', 'пёс и кот')
    applyLocalEdit(text, 'кот и пёс', 'и пёс', 'пёс и кот')
    const result = textString(map, 'body')
    // Чужой текст не стёрт: удалять было нечего — совпадения нет.
    expect(result).toBe('пёс и кот')
  })

  it('после merge обе правки целиком на месте (сценарий двух авторов в одном поле)', () => {
    const left = makeDoc()
    const right = makeDoc()
    const startLeft = addEvent(left.events, { body: 'Общее начало истории.' })
    ensureText(startLeft, 'body')
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))
    const startRight = right.events.get(0) as YMap

    // Оба печатают в конец, каждый видит своё состояние CRDT.
    applyLocalEdit(startLeft.get('body_text') as Y.Text, 'Общее начало истории.', 'Общее начало истории.Аня: ', 'Общее начало истории.')
    applyLocalEdit(startRight.get('body_text') as Y.Text, 'Общее начало истории.', 'Общее начало истории. (Борис)', 'Общее начало истории.')

    Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right.doc))
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc))

    const merged = textString(left.events.get(0) as YMap, 'body')
    expect(textString(right.events.get(0) as YMap, 'body')).toBe(merged)
    // Главное: ни один символ не потерян — обе правки целиком в тексте.
    for (const ch of 'Аня: (Борис)') expect(merged).toContain(ch)
    expect(merged).toContain('Общее начало истории.')
  })
})
