import { describe, expect, it } from 'vitest'
import { resolveLiveText } from './liveText'

/**
 * Политика живого окна Markdown. Проверяем именно решение, а не отрисовку:
 * компонент лишь исполняет то, что вернула эта функция.
 */
describe('resolveLiveText — что делать с пришедшим текстом', () => {
  it('чужой текст молча подставляется, если черновика нет', () => {
    expect(resolveLiveText({ local: 'старое', base: 'старое', remote: 'новое' })).toEqual({
      action: 'adopt',
      base: 'новое',
      text: 'новое',
    })
  })

  it('несохранённый черновик не затирается, но человек узнаёт о правке', () => {
    expect(resolveLiveText({ local: 'я печатаю', base: 'старое', remote: 'соавтор' })).toEqual({
      action: 'notify',
      base: 'соавтор',
    })
  })

  it('эхо собственного сохранения не считается конфликтом', () => {
    // Черновик уже уехал в CRDT и вернулся апдейтом: затирать нечего.
    expect(resolveLiveText({ local: 'мой текст', base: 'старое', remote: 'мой текст' })).toEqual({
      action: 'ignore',
      base: 'мой текст',
    })
  })

  it('правка другого поля события окно не трогает', () => {
    // Кто-то поменял заголовок — текст в CRDT прежний, сравниваем с базой.
    expect(resolveLiveText({ local: 'текст', base: 'текст', remote: 'текст' })).toEqual({
      action: 'ignore',
      base: 'текст',
    })
  })

  it('чужой текст, приехавший при непустом черновике, становится новой базой', () => {
    // Это ключевое свойство: после notify база — версия соавтора, поэтому
    // следующее его изменение не превращается в бесконечный поток предупреждений.
    const first = resolveLiveText({ local: 'я', base: 'база', remote: 'соавтор' })
    expect(first.action).toBe('notify')
    const second = resolveLiveText({ local: 'я печатаю', base: first.base, remote: 'соавтор-2' })
    expect(second.action).toBe('notify')
    expect(second.base).toBe('соавтор-2')
  })

  it('после сохранения конфликта нет: значение из CRDT и есть база', () => {
    // Компонент при сохранении ставит base = text, поэтому повторный апдейт с
    // тем же текстом — обычное «ничего не изменилось».
    expect(resolveLiveText({ local: 'мой текст', base: 'мой текст', remote: 'мой текст' })).toEqual({
      action: 'ignore',
      base: 'мой текст',
    })
  })

  it('пустой черновик — тоже черновик: удаление текста соавтором не подменяем молча', () => {
    // local '' и base 'текст' — человек стёр всё и ещё не сохранил; приняв
    // remote молча, мы бы «вернули» удалённое.
    expect(resolveLiveText({ local: '', base: 'текст', remote: 'чужое' })).toEqual({
      action: 'notify',
      base: 'чужое',
    })
    // А если человек ничего не трогал (base '' и local ''), принимаем спокойно.
    expect(resolveLiveText({ local: '', base: '', remote: 'чужое' }).action).toBe('adopt')
  })
})
