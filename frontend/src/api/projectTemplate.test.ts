import { describe, expect, it } from 'vitest'
import { cardTemplateFor, type EntityType } from './entityTypes'
import { parseTemplate, templateFileName } from './projectTemplate'

/**
 * Шаблон проекта (0.85.0): разбор файла и заготовка карточки.
 *
 * Проверяем не «красиво ли», а то, что человек увидит как отказ или как подставленный текст:
 * «файл не тот» должен читаться словами, а `{{name}}` — заменяться на введённое имя.
 */

const type = (over: Partial<EntityType> = {}): EntityType => ({
  key: 'character',
  title: 'Персонаж',
  color: '',
  icon: '',
  position: 0,
  is_default: true,
  created_at: '',
  ...over,
})

describe('parseTemplate — файл шаблона', () => {
  it('читает типы, карточки и настройки помощника', () => {
    const template = parseTemplate(
      JSON.stringify({
        version: 1,
        entity_types: [
          { key: 'character', title: 'Герой', color: '#88aa66', icon: '⚔', card_template: { description: '{{name}}', aliases: ['герой'] } },
        ],
        cards: [{ kind: 'character', name: 'Анна', aliases: ['Аня'], description: 'главная' }],
        ai: { role: 'Летописец', instructions: 'сдержанно', enabled: true, generation: 'text', image_style: 'карандаш' },
      }),
    )
    expect(template.version).toBe(1)
    expect(template.entity_types).toHaveLength(1)
    expect(template.entity_types[0].card_template?.aliases).toEqual(['герой'])
    expect(template.cards?.[0].name).toBe('Анна')
    expect(template.ai?.role).toBe('Летописец')
  })

  it('«это не шаблон» объясняется словами, а не кодом 500', () => {
    expect(() => parseTemplate('не json')).toThrow(/не похож на JSON/)
    expect(() => parseTemplate('{"version":1}')).toThrow(/нет списка типов/)
    expect(() => parseTemplate('[]')).toThrow(/нет шаблона/)
  })

  it('мусор внутри отбрасывается: тип без ключа и карточка без имени не ломают шаблон', () => {
    const template = parseTemplate(
      JSON.stringify({
        version: 1,
        entity_types: [{ title: 'Без ключа' }, { key: 'place', title: '' }],
        cards: [{ name: '' }, { kind: 'place', name: 'Вокзал' }],
      }),
    )
    expect(template.entity_types.map((item) => item.key)).toEqual(['place'])
    // Пустое название типа заменяется ключом: подпись нужна всегда.
    expect(template.entity_types[0].title).toBe('place')
    expect(template.cards?.map((item) => item.name)).toEqual(['Вокзал'])
  })
})

describe('cardTemplateFor — что подставить в форму карточки', () => {
  it('без заготовки поля пустые', () => {
    expect(cardTemplateFor([type()], 'character', 'Анна')).toEqual({ description: '', aliases: '' })
  })

  it('{{name}} заменяется на имя, алиасы склеиваются через запятую', () => {
    const types = [type({ card_template: { description: '{{name}} — герой.', aliases: ['герой', 'протагонист'] } })]
    expect(cardTemplateFor(types, 'character', ' Анна ')).toEqual({
      description: 'Анна — герой.',
      aliases: 'герой, протагонист',
    })
  })

  it('без имени подстановка не делается: видно, куда попадёт имя', () => {
    const types = [type({ card_template: { description: '{{name}} — герой.' } })]
    expect(cardTemplateFor(types, 'character', '   ').description).toBe('{{name}} — герой.')
  })
})

describe('templateFileName', () => {
  it('кириллическое название даёт запасное имя, латинское — своё', () => {
    expect(templateFileName('Роман')).toBe('project-template.json')
    expect(templateFileName('My Story')).toBe('my-story-template.json')
  })
})
