import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Каталог резидентов: разбор ответа и правило «короткий запрос не ходит в сеть».
 *
 * Сеть здесь подменяется целиком: проверяем ровно то, что уходит на сервер и что
 * из ответа получает страница, — без стенда и без токена.
 */
const mocks = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('./client', () => ({ http: { get: mocks.get } }))

import { getPerson, listPeople, PEOPLE_PAGE_SIZE } from './people'

/** Ответ клиента: странице нужен только json(). */
function reply(body: unknown) {
  return { json: async () => body }
}

describe('listPeople', () => {
  beforeEach(() => mocks.get.mockReset())

  it('не ходит в сеть, когда запрос короче двух символов', async () => {
    const page = await listPeople({ q: 'a' })
    expect(mocks.get).not.toHaveBeenCalled()
    expect(page).toEqual({ items: [], total: 0, limit: PEOPLE_PAGE_SIZE, offset: 0 })
  })

  it('считает запрос из одних пробелов отсутствием поиска', async () => {
    mocks.get.mockReturnValue(reply({ items: [], total: 0, limit: 24, offset: 0 }))
    await listPeople({ q: '   ' })
    expect(mocks.get).toHaveBeenCalledWith('users', { searchParams: { limit: '24', offset: '0' } })
  })

  it('разбирает ответ каталога и передаёт поиск с фильтром', async () => {
    const raw = {
      items: [
        {
          id: 'u1',
          username: 'anna.design',
          display_name: 'Анна',
          bio: 'Пишу миры и правила магии',
          crafts: ['Диалоги'],
          relation: 'coauthor',
          public_stories: 2,
        },
      ],
      total: 41,
      limit: 24,
      offset: 0,
    }
    mocks.get.mockReturnValue(reply(raw))
    const page = await listPeople({ q: '  анна ', craft: 'Диалоги', limit: 24, offset: 0 })
    expect(mocks.get).toHaveBeenCalledWith('users', {
      searchParams: { limit: '24', offset: '0', q: 'анна', craft: 'Диалоги' },
    })
    expect(page.items).toEqual(raw.items)
    expect(page.total).toBe(41)
  })

  it('подстраховывает конверт: без total счётчик не станет NaN', async () => {
    mocks.get.mockReturnValue(reply({ items: [{ id: 'u1' }] }))
    const page = await listPeople({ limit: 10, offset: 20 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(1)
    expect(page.limit).toBe(10)
    expect(page.offset).toBe(20)
  })

  it('передаёт листание отдельными параметрами', async () => {
    mocks.get.mockReturnValue(reply({ items: [], total: 3, limit: 24, offset: 24 }))
    await listPeople({ offset: 24 })
    expect(mocks.get).toHaveBeenCalledWith('users', { searchParams: { limit: '24', offset: '24' } })
  })
})

describe('getPerson', () => {
  beforeEach(() => mocks.get.mockReset())

  it('раскрывает профиль с публичными историями и кодирует id', async () => {
    mocks.get.mockReturnValue(reply({
      id: 'u 1',
      username: 'anna.design',
      display_name: 'Анна',
      bio: '',
      crafts: [],
      relation: '',
      public_stories: 1,
      stories: [{ id: 's1', title: 'Глава первая', slug: 'glava-1' }],
    }))
    const person = await getPerson('u 1')
    expect(mocks.get).toHaveBeenCalledWith('users/u%201')
    expect(person.stories).toHaveLength(1)
    expect(person.stories[0].slug).toBe('glava-1')
  })

  it('не падает, если историй в ответе нет', async () => {
    mocks.get.mockReturnValue(reply({
      id: 'u1',
      username: 'anna.design',
      display_name: 'Анна',
      bio: 'Пишу',
      crafts: ['Диалоги'],
      relation: 'request-outgoing',
      public_stories: 0,
    }))
    const person = await getPerson('u1')
    expect(person.stories).toEqual([])
    expect(person.relation).toBe('request-outgoing')
  })
})
