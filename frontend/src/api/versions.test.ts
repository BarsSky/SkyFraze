import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))

vi.mock('./client', () => ({ http: { get: mocks.get, post: mocks.post, delete: mocks.del } }))

import {
  deleteProjectVersion,
  getProjectVersion,
  listProjectVersions,
  parsePreview,
  parseRestoreResult,
  parseVersions,
  restoreProjectVersion,
  saveProjectVersion,
} from './versions'

function reply(body: unknown) {
  return { json: async () => body }
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  mocks.del.mockReset()
})

describe('parseVersions', () => {
  it('читает версии и терпит отсутствующие поля', () => {
    const list = parseVersions({
      versions: [
        {
          id: 'v1',
          kind: 'manual',
          label: 'перед переписыванием',
          events: 3,
          size: 2048,
          created_at: '2026-10-24T10:00:00Z',
          created_by: 'u1',
        },
        // Без id версию нельзя ни показать, ни восстановить — пропускаем.
        { kind: 'auto' },
        { id: 'v2', events: -5, size: 'много' },
      ],
    })
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      id: 'v1',
      kind: 'manual',
      label: 'перед переписыванием',
      events: 3,
      size: 2048,
      createdAt: '2026-10-24T10:00:00Z',
      createdBy: 'u1',
    })
    // Отрицательные и нечисловые значения — нули, а не «−5 кадров» в интерфейсе.
    expect(list[1]).toMatchObject({ events: 0, size: 0, kind: 'auto', createdBy: null })

    expect(parseVersions(null)).toEqual([])
    expect(parseVersions({})).toEqual([])
  })
})

describe('parsePreview', () => {
  it('читает дерево версии и считает знаки', () => {
    const preview = parsePreview({
      version: { id: 'v1', events: 2, size: 100 },
      frames: [
        { id: 'e1', depth: 0, title: 'Глава 1', date: '2026-01-02', chars: 10 },
        { id: 'e2', depth: 1, title: 'Под-событие', chars: 5 },
        { title: 'без id' },
      ],
      chars: 15,
    })
    expect(preview).not.toBeNull()
    expect(preview!.frames).toHaveLength(2)
    expect(preview!.frames[1]).toMatchObject({ depth: 1, title: 'Под-событие', chars: 5 })
    expect(preview!.chars).toBe(15)
    // Без версии показывать нечего.
    expect(parsePreview({ frames: [] })).toBeNull()
  })
})

describe('parseRestoreResult', () => {
  it('считает изменения восстановления', () => {
    expect(parseRestoreResult({ removed: 1, added: 2, updated: 3, moved: 1, warning: 'ошибка' })).toEqual({
      removed: 1,
      added: 2,
      updated: 3,
      moved: 1,
      warning: 'ошибка',
    })
    expect(parseRestoreResult(null)).toEqual({ removed: 0, added: 0, updated: 0, moved: 0, warning: '' })
  })
})

describe('запросы версий', () => {
  it('уходят на свои адреса', async () => {
    mocks.get.mockReturnValueOnce(reply({ versions: [] }))
    await listProjectVersions('p1', 20)
    expect(mocks.get).toHaveBeenCalledWith('projects/p1/versions', {
      searchParams: { limit: '20' },
    })

    mocks.post.mockReturnValueOnce(reply({ id: 'v1' }))
    await saveProjectVersion('p1', 'подпись')
    expect(mocks.post).toHaveBeenCalledWith('projects/p1/versions', {
      json: { label: 'подпись' },
      timeout: 30000,
    })

    mocks.get.mockReturnValueOnce(reply({ version: { id: 'v1' }, frames: [] }))
    await getProjectVersion('p1', 'v1')
    expect(mocks.get).toHaveBeenCalledWith('projects/p1/versions/v1')

    mocks.post.mockReturnValueOnce(reply({ added: 1 }))
    await restoreProjectVersion('p1', 'v1')
    expect(mocks.post).toHaveBeenCalledWith('projects/p1/versions/v1/restore', { timeout: 60000 })

    mocks.del.mockReturnValueOnce(reply({}))
    await deleteProjectVersion('p1', 'v1')
    expect(mocks.del).toHaveBeenCalledWith('projects/p1/versions/v1')
  })
})
