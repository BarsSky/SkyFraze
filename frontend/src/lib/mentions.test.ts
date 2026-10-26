import { describe, expect, it } from 'vitest'
import {
  applyMention,
  matchMentionCandidates,
  mentionQueryAt,
  splitMentions,
} from './mentions'

/**
 * Упоминания в обсуждении.
 *
 * Проверяем ровно те места, где легко ошибиться и где ошибка тихая: подсветка не должна
 * цеплять email и кириллицу, подсказка не должна открываться посреди слова, вставка ника
 * должна заменять набранный кусок, а не дописывать к нему.
 */

describe('splitMentions', () => {
  it('помечает ник и оставляет текст вокруг', () => {
    const parts = splitMentions('Смотри @editor, тут дыра')
    expect(parts.map((p) => (p.mention ? `[${p.text}]` : p.text)).join('')).toBe(
      'Смотри [@editor], тут дыра',
    )
  })

  it('не считает упоминанием email', () => {
    const parts = splitMentions('пиши на editor@example.com')
    expect(parts.every((p) => !p.mention)).toBe(true)
  })

  it('кириллица после собаки — обычный текст', () => {
    const parts = splitMentions('@Серёжа, посмотри')
    expect(parts.every((p) => !p.mention)).toBe(true)
  })

  it('точка в конце фразы в ник не входит', () => {
    const parts = splitMentions('спроси @editor.')
    const mention = parts.find((p) => p.mention)
    expect(mention?.text).toBe('@editor')
  })

  it('слишком короткий ник не подсвечивается', () => {
    expect(splitMentions('@ok').every((p) => !p.mention)).toBe(true)
  })

  it('пустой текст — пустой список', () => {
    expect(splitMentions('')).toEqual([])
  })
})

describe('mentionQueryAt', () => {
  it('видит набираемый ник', () => {
    expect(mentionQueryAt('привет @ed', 11)).toEqual({ start: 7, query: 'ed' })
  })

  it('сразу после собаки запрос пустой — показать всех участников', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('посреди слова подсказку не открывает', () => {
    expect(mentionQueryAt('editor@example', 14)).toBeNull()
  })

  it('после ника и пробела запрос закрыт', () => {
    expect(mentionQueryAt('@editor ', 8)).toBeNull()
  })

  it('без собаки — null', () => {
    expect(mentionQueryAt('привет', 6)).toBeNull()
  })
})

describe('applyMention', () => {
  it('заменяет набранный кусок ником и ставит пробел', () => {
    const text = 'привет @ed'
    const { text: next, caret } = applyMention(text, 7, 10, 'editor')
    expect(next).toBe('привет @editor ')
    expect(caret).toBe(next.length)
  })

  it('дописывает продолжение текста после каретки', () => {
    const text = 'смотри @ed и пиши'
    const { text: next } = applyMention(text, 7, 10, 'editor')
    expect(next).toBe('смотри @editor  и пиши')
  })
})

describe('matchMentionCandidates', () => {
  const candidates = [
    { username: 'editor', displayName: 'Редактор' },
    { username: 'edgar', displayName: 'Эдгар' },
    { username: 'owner', displayName: 'Владелец' },
    { username: '', displayName: 'Без ника' },
  ]

  it('фильтрует по началу ника', () => {
    const got = matchMentionCandidates(candidates, 'ed')
    expect(got.map((c) => c.username)).toEqual(['editor', 'edgar'])
  })

  it('пустой запрос — все с ником, без пустых', () => {
    const got = matchMentionCandidates(candidates, '')
    expect(got.map((c) => c.username)).toEqual(['editor', 'edgar', 'owner'])
  })

  it('уважает предел подсказок', () => {
    expect(matchMentionCandidates(candidates, '', 2)).toHaveLength(2)
  })
})
