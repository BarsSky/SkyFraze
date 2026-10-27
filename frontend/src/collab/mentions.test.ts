import { describe, expect, it } from 'vitest'
import {
  MIN_ALIAS_LENGTH,
  entityUsage,
  findMentions,
  frameMentions,
  type MentionEntity,
} from './mentions'

/**
 * Поиск упоминаний карточек в тексте.
 *
 * Тесты здесь — это и есть спецификация правил: каждый случай ниже когда-нибудь случится в
 * реальном тексте, и ошибка в любом из них означает либо пропущенную связь, либо ложную.
 */

const anna: MentionEntity = { id: 'e1', name: 'Анна', aliases: ['Аня', 'Анны', 'Анне'] }
const home: MentionEntity = { id: 'e2', name: 'Дом на холме', aliases: [] }
const letter: MentionEntity = { id: 'e3', name: 'Письмо', aliases: [] }

const names = (text: string, entities: MentionEntity[] = [anna, home, letter]) =>
  findMentions(text, entities).map((m) => [m.entityName, m.quote])

describe('findMentions', () => {
  it('находит имя в любом падеже, заданном алиасом', () => {
    expect(names('Анна вошла.')).toEqual([['Анна', 'Анна']])
    expect(names('История Анны.')).toEqual([['Анна', 'Анны']])
    expect(names('Сказал Анне.')).toEqual([['Анна', 'Анне']])
    expect(names('Аня пришла.')).toEqual([['Анна', 'Аня']])
  })

  it('падеж, которого нет в алиасах, не находится — и это честнее догадки', () => {
    // Морфологии мы не делаем: форма либо добавлена человеком в алиасы, либо связи не будет.
    // Пропустить лучше, чем связать не с той Анной.
    expect(names('Позвал Аню.')).toEqual([])
  })

  it('не учитывает регистр: «анна» — это та же Анна', () => {
    expect(names('и тут анна поняла')).toEqual([['Анна', 'анна']])
  })

  it('длинный алиас выигрывает у короткого на одном месте', () => {
    const surname: MentionEntity = { id: 'e4', name: 'Анна Сергеевна', aliases: ['Анна Сергеевна'] }
    // Одна карточка «Анна» и одна «Анна Сергеевна»: на «Анна Сергеевна» должно быть ОДНО
    // упоминание — второй карточки, а не обеих.
    expect(names('Пришла Анна Сергеевна.', [anna, surname])).toEqual([
      ['Анна Сергеевна', 'Анна Сергеевна'],
    ])
  })

  it('границы слова: не находит «Анна» внутри другого слова', () => {
    expect(names('Аннами называли всех')).toEqual([])
    expect(names('Анна-Мария вошла')).toEqual([])
    expect(names('ПраАнна')).toEqual([])
  })

  it('находит несколько упоминаний в одном тексте, в порядке появления', () => {
    expect(names('Анна вошла в дом на холме. Дом на холме молчал, а Анна ждала.')).toEqual([
      ['Анна', 'Анна'],
      ['Дом на холме', 'дом на холме'],
      ['Дом на холме', 'Дом на холме'],
      ['Анна', 'Анна'],
    ])
  })

  it('короткие алиасы не ищутся: «Я» нашлось бы в каждом предложении', () => {
    const short: MentionEntity = { id: 'e5', name: 'Я', aliases: ['Я'] }
    expect(MIN_ALIAS_LENGTH).toBe(2)
    expect(findMentions('Я пришёл, и я остался', [short])).toEqual([])
  })

  it('алиасы сспецсимволами не ломают поиск', () => {
    const weird: MentionEntity = { id: 'e6', name: 'Дом (старый)', aliases: ['Дом (старый)'] }
    expect(names('Вошёл в Дом (старый) вечером', [weird])).toEqual([['Дом (старый)', 'Дом (старый)']])
  })

  it('пустой текст и пустой набор карточек — пустой результат, без исключений', () => {
    expect(findMentions('', [anna])).toEqual([])
    expect(findMentions('Анна вошла', [])).toEqual([])
    expect(findMentions('Анна вошла', [{ id: 'x', name: '', aliases: [] }])).toEqual([])
  })

  it('заголовок ищется отдельным полем, а не склеивается с текстом', () => {
    const frame = { id: 'f1', title: 'Анна возвращается', body: 'Дом на холме и Анна' }
    const found = frameMentions(frame, [anna, home])
    expect(found.map((m) => [m.field, m.quote])).toEqual([
      ['title', 'Анна'],
      ['body', 'Дом на холме'],
      ['body', 'Анна'],
    ])
  })
})

describe('entityUsage', () => {
  it('считает кадры и упоминания: два упоминания в одном кадре — один кадр', () => {
    const frames = [
      { id: 'f1', title: 'Анна', body: 'Анна и снова Анна' },
      { id: 'f2', title: '', body: 'Дом на холме' },
      { id: 'f3', title: '', body: 'ничего' },
    ]
    const usage = entityUsage(frames, [anna, home, letter])
    expect(usage.e1).toEqual({ frames: 1, mentions: 3 })
    expect(usage.e2).toEqual({ frames: 1, mentions: 1 })
    // Карточка без упоминаний остаётся в отчёте с нулями: «сироту» надо увидеть, а не угадать.
    expect(usage.e3).toEqual({ frames: 0, mentions: 0 })
  })

  it('пустой проект — все карточки с нулями', () => {
    expect(entityUsage([], [anna])).toEqual({ e1: { frames: 0, mentions: 0 } })
  })
})
