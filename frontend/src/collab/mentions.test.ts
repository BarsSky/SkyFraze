import { describe, expect, it } from 'vitest'
import {
  MIN_ALIAS_LENGTH,
  entityUsage,
  findMentions,
  frameMentions,
  framesByEntity,
  mentionMatrix,
  orderChronologically,
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

describe('framesByEntity / хронология', () => {
  const frames = [
    // Порядок в списке — порядок дерева: order задан явно, чтобы тест не зависел от индексов.
    { id: 'f1', title: 'Пролог', body: 'Анна', date: '', order: 0 },
    { id: 'f2', title: 'Встреча', body: 'Анна и Дом на холме', date: '2026-03-02', order: 1 },
    { id: 'f3', title: 'Письмо', body: 'Письмо для Анны', date: '2026-01-15', order: 2 },
    { id: 'f4', title: 'Развязка', body: 'Письмо', date: '', order: 3 },
  ]

  it('сначала кадры с датой по возрастанию, затем без даты в порядке дерева', () => {
    const byEntity = framesByEntity(frames, [anna, home, letter])
    expect(byEntity.e1.map((f) => f.frameId)).toEqual(['f3', 'f2', 'f1'])
    expect(byEntity.e2.map((f) => f.frameId)).toEqual(['f2'])
    expect(byEntity.e3.map((f) => f.frameId)).toEqual(['f3', 'f4'])
  })

  it('в кадре сохраняются все упоминания: по ним видно, каким словом названо', () => {
    const byEntity = framesByEntity(
      [{ id: 'f1', title: 'Анна', body: 'Анна и Анны подруги', date: '', order: 0 }],
      [anna],
    )
    expect(byEntity.e1[0].mentions.map((m) => [m.field, m.quote])).toEqual([
      ['title', 'Анна'],
      ['body', 'Анна'],
      ['body', 'Анны'],
    ])
  })

  it('карточка без упоминаний остаётся с пустым списком, а не исчезает', () => {
    const byEntity = framesByEntity(frames, [anna, { id: 'e9', name: 'Сторож', aliases: [] }])
    expect(byEntity.e9).toEqual([])
  })

  it('одинаковые даты упорядочены по дереву, а не случайно', () => {
    const same = [
      { frameId: 'b', title: '', number: '', date: '2026-05-05', order: 5, mentions: [] },
      { frameId: 'a', title: '', number: '', date: '2026-05-05', order: 1, mentions: [] },
    ]
    expect(orderChronologically(same).map((f) => f.frameId)).toEqual(['a', 'b'])
  })
})

describe('mentionMatrix — персонажи × главы (0.71.0)', () => {
  const chapters = [
    { id: 'ch1', title: 'Пролог', number: '01' },
    { id: 'ch2', title: 'Развязка', number: '02' },
  ]
  const frames = [
    { id: 'f1', title: 'Пролог', body: 'Анна вошла', date: '', order: 0 },
    { id: 'f2', title: 'Сцена', body: 'Анна и Дом на холме', date: '', order: 1 },
    { id: 'f3', title: 'Развязка', body: 'Дом на холме пуст', date: '', order: 2 },
  ]
  const frameChapters = [
    { frameId: 'f1', chapterId: 'ch1' },
    { frameId: 'f2', chapterId: 'ch1' },
    { frameId: 'f3', chapterId: 'ch2' },
  ]

  it('считает упоминания по главам и ставит главных сверху', () => {
    const matrix = mentionMatrix(frames, frameChapters, chapters, [anna, home, letter])
    expect(matrix.chapters.map((c) => c.id)).toEqual(['ch1', 'ch2'])
    // Анна: два упоминания в первой главе; Дом: по одному в каждой; Письмо — ни разу.
    expect(matrix.rows[0].entity.id).toBe('e1')
    expect(matrix.rows[0].cells.map((cell) => cell.count)).toEqual([2, 0])
    expect(matrix.rows[1].entity.id).toBe('e2')
    expect(matrix.rows[1].cells.map((cell) => cell.count)).toEqual([1, 1])
    expect(matrix.rows[2].entity.id).toBe('e3')
    expect(matrix.rows[2].total).toBe(0)
  })

  it('пустые главы не становятся столбцами: таблица не шире экрана зря', () => {
    const matrix = mentionMatrix(
      [frames[2]],
      [{ frameId: 'f3', chapterId: 'ch2' }],
      chapters,
      [home],
    )
    expect(matrix.chapters.map((c) => c.id)).toEqual(['ch2'])
  })

  it('кадр без главы в матрицу не попадает: столбца для него нет', () => {
    const matrix = mentionMatrix(frames, [], chapters, [anna])
    expect(matrix.chapters).toEqual([])
    expect(matrix.rows[0].cells).toEqual([])
    expect(matrix.rows[0].total).toBe(0)
  })
})
