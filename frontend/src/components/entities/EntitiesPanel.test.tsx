import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntitiesPanel, splitAliases } from './EntitiesPanel'

/**
 * «Связи проекта»: карточки персонажей, мест и тем (фаза 1).
 *
 * Проверяем то, что человек делает руками и на чём легко ошибиться: алиасы уезжают на сервер
 * списком (а не строкой с запятыми), имя не уходит пустым, отказ сервера объясняется его же
 * словами («имя уже занято»), правка и удаление требуют явного действия, а читателю кнопок не
 * показывают вовсе — вместо «нажал и получил 403».
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../api/entities', async () => {
  const actual = await vi.importActual<typeof import('../../api/entities')>('../../api/entities')
  return {
    ...actual,
    listEntities: mocks.list,
    createEntity: mocks.create,
    updateEntity: mocks.update,
    deleteEntity: mocks.remove,
  }
})

const entity = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  kind: 'character',
  name: 'Анна',
  aliases: ['Аня'],
  description: '',
  color: '',
  created_at: '2026-10-27T09:00:00Z',
  updated_at: '2026-10-27T09:00:00Z',
  ...over,
})

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue([])
  mocks.create.mockReset()
  mocks.update.mockReset()
  mocks.remove.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('EntitiesPanel', () => {
  it('пустой список объясняет, с чего начать', async () => {
    render(<EntitiesPanel projectId="p1" canEdit />)
    expect(await screen.findByText(/Карточек пока нет/)).toBeTruthy()
    expect(screen.getByText(/главного героя и места/)).toBeTruthy()
  })

  it('создание: имя и алиасы уезжают на сервер, карточка появляется в списке', async () => {
    mocks.create.mockResolvedValue(entity({ id: 'e9', name: 'Сторож', aliases: ['Сторожа'] }))
    render(<EntitiesPanel projectId="p1" canEdit />)
    await screen.findByText(/Карточек пока нет/)

    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Сторож' } })
    fireEvent.change(screen.getByLabelText('Алиасы карточки'), { target: { value: 'Сторожа, ' } })
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('p1', {
        kind: 'character',
        name: 'Сторож',
        aliases: ['Сторожа'],
      }),
    )
    expect(await screen.findByText('Сторож')).toBeTruthy()
    expect(screen.getByText(/Карточка «Сторож» создана/)).toBeTruthy()
  })

  it('пустое имя не отправляется', async () => {
    render(<EntitiesPanel projectId="p1" canEdit />)
    await screen.findByText(/Карточек пока нет/)
    const add = screen.getByRole('button', { name: /Добавить/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  it('занятое имя объясняется словами сервера, а не кодом 409', async () => {
    mocks.create.mockRejectedValue({
      response: { clone: () => ({ json: async () => ({ error: 'сущность с таким именем уже есть в проекте' }) }) },
    })
    render(<EntitiesPanel projectId="p1" canEdit />)
    await screen.findByText(/Карточек пока нет/)
    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Анна' } })
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))
    expect(await screen.findByText(/уже есть в проекте/)).toBeTruthy()
  })

  it('список сортируется: персонажи, места, темы; внутри вида — по имени', async () => {
    mocks.list.mockResolvedValue([
      entity({ id: 't1', kind: 'theme', name: 'Письмо' }),
      entity({ id: 'p2', kind: 'place', name: 'Вокзал' }),
      entity({ id: 'c2', kind: 'character', name: 'Борис' }),
      entity({ id: 'c1', kind: 'character', name: 'Анна' }),
    ])
    render(<EntitiesPanel projectId="p1" canEdit />)
    const list = await screen.findByRole('list')
    const names = Array.from(list.querySelectorAll('.ent__name')).map((n) => n.textContent)
    expect(names).toEqual(['Анна', 'Борис', 'Вокзал', 'Письмо'])
  })

  it('правка: имя и алиасы на месте, сохранение уходит на сервер', async () => {
    mocks.list.mockResolvedValue([entity()])
    mocks.update.mockResolvedValue(entity({ aliases: ['Аня', 'Аннушка'] }))
    render(<EntitiesPanel projectId="p1" canEdit />)
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Изменить карточку Анна'))
    fireEvent.change(screen.getByLabelText('Алиасы карточки Анна'), {
      target: { value: 'Аня, Аннушка' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', {
        name: 'Анна',
        aliases: ['Аня', 'Аннушка'],
      }),
    )
    expect(await screen.findByText(/Изменения сохранены/)).toBeTruthy()
  })

  it('удаление требует подтверждения', async () => {
    mocks.list.mockResolvedValue([entity()])
    render(<EntitiesPanel projectId="p1" canEdit />)
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Удалить карточку Анна'))
    expect(mocks.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'e1'))
    expect(await screen.findByText(/Карточка удалена/)).toBeTruthy()
  })

  it('читателю кнопок не показывают: видно карточки, но не действия', async () => {
    mocks.list.mockResolvedValue([entity()])
    render(<EntitiesPanel projectId="p1" canEdit={false} />)
    await screen.findByText('Анна')
    expect(screen.queryByRole('button', { name: /Добавить/ })).toBeNull()
    expect(screen.queryByLabelText('Изменить карточку Анна')).toBeNull()
    expect(screen.queryByLabelText('Удалить карточку Анна')).toBeNull()
  })
})

describe('splitAliases', () => {
  it('делит по запятой и выбрасывает пустое', () => {
    expect(splitAliases('Аня, Анны,  ,')).toEqual(['Аня', 'Анны'])
    expect(splitAliases('')).toEqual([])
  })
})
