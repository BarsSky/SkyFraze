import { afterEach, describe, expect, it, vi } from 'vitest'
import { listMentionImages, mentionImageKey } from './mentionImages'
import { http } from './client'

/**
 * Картинки упоминаний (0.93.0): разбор ответа сервера.
 *
 * Список приходит массивом записей, а панель «Связи» ищет картинку по паре «карточка × кадр» —
 * поэтому проверяем, что из ответа получается словарь и что битые записи не превращают пару в
 * «карточка:undefined».
 */

afterEach(() => vi.restoreAllMocks())

function mockGet(payload: unknown) {
  const json = vi.fn().mockResolvedValue(payload)
  const get = vi.fn().mockReturnValue({ json })
  vi.spyOn(http, 'get').mockImplementation(get as never)
  return get
}

describe('mentionImageKey', () => {
  it('различает кадры одной карточки', () => {
    expect(mentionImageKey('e1', 'f1')).toBe('e1:f1')
    expect(mentionImageKey('e1', 'f1')).not.toBe(mentionImageKey('e1', 'f2'))
  })
})

describe('listMentionImages', () => {
  it('превращает список в словарь по парам', async () => {
    const get = mockGet({
      images: [
        { entity_id: 'e1', event_id: 'f1', asset_id: 'a1' },
        { entity_id: 'e1', event_id: 'f2', asset_id: 'a2' },
      ],
    })
    const images = await listMentionImages('p1')
    expect(get).toHaveBeenCalledWith('projects/p1/mention-images')
    expect(images).toEqual({ 'e1:f1': 'a1', 'e1:f2': 'a2' })
  })

  it('битые записи пропускаются: пара без картинки честнее «e1:undefined»', async () => {
    mockGet({
      images: [
        { entity_id: 'e1', event_id: 'f1' },
        { entity_id: 'e1', event_id: 'f2', asset_id: 'a2' },
        null,
        'строка',
      ],
    })
    expect(await listMentionImages('p1')).toEqual({ 'e1:f2': 'a2' })
  })

  it('пустой ответ — пустой словарь, а не падение', async () => {
    mockGet({})
    expect(await listMentionImages('p1')).toEqual({})
  })
})
