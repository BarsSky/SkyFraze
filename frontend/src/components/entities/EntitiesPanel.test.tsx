import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntitiesPanel, describeUsage, splitAliases } from './EntitiesPanel'
import type { ProjectEntity } from '../../api/entities'

/**
 * «Связи проекта»: карточки персонажей, мест и тем (0.67.0) и счётчики упоминаний (0.68.0).
 *
 * Данные панель получает от владельца (панель редакторов) и после правок просит перечитать
 * список: карточки нужны ещё и поиску упоминаний в тексте. Поэтому проверяется в том числе то,
 * что после создания вызывается `reload`, а не тихо правится локальная копия.
 */

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn() }))

vi.mock('../../api/entities', async () => {
  const actual = await vi.importActual<typeof import('../../api/entities')>('../../api/entities')
  return {
    ...actual,
    createEntity: mocks.create,
    updateEntity: mocks.update,
    deleteEntity: mocks.remove,
  }
})

const entity = (over: Partial<ProjectEntity> = {}): ProjectEntity => ({
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

const panel = (props: Partial<Parameters<typeof EntitiesPanel>[0]> = {}) => {
  const reload = vi.fn()
  const result = render(
    <EntitiesPanel projectId="p1" canEdit entities={[]} loaded reload={reload} {...props} />,
  )
  return { ...result, reload }
}

beforeEach(() => {
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
    panel()
    expect(await screen.findByText(/Карточек пока нет/)).toBeTruthy()
    expect(screen.getByText(/главного героя и места/)).toBeTruthy()
  })

  it('создание: имя и алиасы уезжают на сервер, список перечитывается', async () => {
    mocks.create.mockResolvedValue(entity({ id: 'e9', name: 'Сторож', aliases: ['Сторожа'] }))
    const { reload } = panel()
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
    expect(await screen.findByText(/Карточка «Сторож» создана/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
  })

  it('пустое имя не отправляется', async () => {
    panel()
    await screen.findByText(/Карточек пока нет/)
    const add = screen.getByRole('button', { name: /Добавить/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  it('занятое имя объясняется словами сервера, а не кодом 409', async () => {
    mocks.create.mockRejectedValue({
      response: { clone: () => ({ json: async () => ({ error: 'сущность с таким именем уже есть в проекте' }) }) },
    })
    panel()
    await screen.findByText(/Карточек пока нет/)
    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Анна' } })
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))
    expect(await screen.findByText(/уже есть в проекте/)).toBeTruthy()
  })

  it('карточки показываются в присланном порядке и с алиасами', async () => {
    panel({
      entities: [
        entity({ id: 'c1', kind: 'character', name: 'Анна' }),
        entity({ id: 'p1e', kind: 'place', name: 'Вокзал', aliases: [] }),
        entity({ id: 't1', kind: 'theme', name: 'Письмо', aliases: [] }),
      ],
    })
    const list = await screen.findByRole('list')
    const names = Array.from(list.querySelectorAll('.ent__name')).map((n) => n.textContent)
    expect(names).toEqual(['Анна', 'Вокзал', 'Письмо'])
    expect(screen.getByText('(Аня)')).toBeTruthy()
  })

  it('счётчик упоминаний: кадры и упоминания, а ноль — словами', async () => {
    panel({
      entities: [entity({ id: 'e1' }), entity({ id: 'e2', name: 'Письмо', aliases: [] })],
      usage: { e1: { frames: 2, mentions: 3 }, e2: { frames: 0, mentions: 0 } },
    })
    expect(await screen.findByText('2 кадра · 3 упоминания')).toBeTruthy()
    expect(screen.getByText('пока не упоминается')).toBeTruthy()
  })

  it('правка: имя и алиасы на месте, сохранение уходит на сервер', async () => {
    mocks.update.mockResolvedValue(entity({ aliases: ['Аня', 'Аннушка'] }))
    const { reload } = panel({ entities: [entity()] })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Изменить карточку Анна'))
    fireEvent.change(screen.getByLabelText('Алиасы карточки Анна'), {
      target: { value: 'Аня, Аннушка' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', { name: 'Анна', aliases: ['Аня', 'Аннушка'] }),
    )
    expect(await screen.findByText(/Изменения сохранены/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
  })

  it('удаление требует подтверждения', async () => {
    const { reload } = panel({ entities: [entity()] })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Удалить карточку Анна'))
    expect(mocks.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('p1', 'e1'))
    expect(await screen.findByText(/Карточка удалена/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
  })

  it('читателю кнопок не показывают: видно карточки, но не действия', async () => {
    panel({ canEdit: false, entities: [entity()] })
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

describe('describeUsage', () => {
  it('склоняет по-русски, а не «2 кадр»', () => {
    expect(describeUsage({ frames: 1, mentions: 1 })).toBe('1 кадр · 1 упоминание')
    expect(describeUsage({ frames: 2, mentions: 3 })).toBe('2 кадра · 3 упоминания')
    expect(describeUsage({ frames: 5, mentions: 11 })).toBe('5 кадров · 11 упоминаний')
    expect(describeUsage({ frames: 21, mentions: 22 })).toBe('21 кадр · 22 упоминания')
  })

  it('ноль кадров — словами: карточка ничего не связывает', () => {
    expect(describeUsage({ frames: 0, mentions: 0 })).toBe('пока не упоминается')
  })
})

describe('EntitiesPanel — хронология (0.69.0)', () => {
describe('хронология карточки (0.69.0)', () => {
  const frames = [
    {
      frameId: 'f1',
      title: 'Встреча',
      number: '01.2',
      date: '2026-03-02',
      order: 1,
      mentions: [
        { entityId: 'e1', entityName: 'Анна', field: 'body' as const, from: 5, to: 9, quote: 'Анны' },
      ],
    },
    {
      frameId: 'f2',
      title: 'Пролог',
      number: '01',
      date: '',
      order: 0,
      mentions: [
        { entityId: 'e1', entityName: 'Анна', field: 'title' as const, from: 0, to: 4, quote: 'Анна' },
      ],
    },
  ]

  it('«Где встречается» раскрывает кадры с номерами и датами', async () => {
    panel({ entities: [entity()], framesByEntity: { e1: frames } })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Где встречается Анна'))
    expect(await screen.findByText('Встреча')).toBeTruthy()
    expect(screen.getByText('01.2')).toBeTruthy()
    expect(screen.getByText('2026-03-02')).toBeTruthy()
    // Кадр без даты в списке есть, но даты у него нет — так и должно выглядеть.
    expect(screen.getByText('Пролог')).toBeTruthy()
  })

  it('клик по кадру отдаёт кадр и упоминание: панель выделит место', async () => {
    const onOpenFrame = vi.fn()
    panel({ entities: [entity()], framesByEntity: { e1: frames }, onOpenFrame })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Где встречается Анна'))
    fireEvent.click(await screen.findByText('Встреча'))
    expect(onOpenFrame).toHaveBeenCalledWith('f1', expect.objectContaining({ quote: 'Анны' }))
  })

  it('без упоминаний кнопки «Где встречается» нет: раскрывать нечего', async () => {
    panel({ entities: [entity()], framesByEntity: { e1: [] } })
    await screen.findByText('Анна')
    expect(screen.queryByLabelText('Где встречается Анна')).toBeNull()
  })
})
})
describe('EntitiesPanel — матрица связей (0.71.0)', () => {
  it('показывает таблицу с главами и количеством, а ноль — точкой', async () => {
    panel({
      entities: [entity({ id: 'e1' }), entity({ id: 'e2', name: 'Письмо', aliases: [] })],
      matrix: {
        chapters: [
          { id: 'ch1', title: 'Пролог', number: '01' },
          { id: 'ch2', title: 'Развязка', number: '02' },
        ],
        rows: [
          { entity: { id: 'e1', name: 'Анна', aliases: [] }, cells: [{ count: 2 }, { count: 0 }], total: 2 },
          { entity: { id: 'e2', name: 'Письмо', aliases: [] }, cells: [{ count: 0 }, { count: 1 }], total: 1 },
        ],
      },
    })
    // «Анна» встречается дважды — в списке карточек и в матрице: таблица есть в DOM, даже
    // когда `details` закрыт, поэтому ищем все совпадения.
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    // В шапке столбца — номер главы (название в title): в узкой таблице номер короче.
    expect(await screen.findByText('01')).toBeTruthy()
    expect(screen.getByText('02')).toBeTruthy()
    expect(screen.getByTitle('Пролог')).toBeTruthy()
    // Нули — точкой: пустая клетка читается как «не загрузилось».
    expect(screen.getAllByText('·').length).toBe(2)
    expect(screen.getByText('всего')).toBeTruthy()
    // Клетка с упоминаниями — ссылка в кадр (0.73.0).
    expect(screen.getByRole('button', { name: '2' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '·' })).toBeNull()
  })

  it('без глав матрицы нет: раскрывать нечего', async () => {
    panel({ entities: [entity()], matrix: { chapters: [], rows: [] } })
    await screen.findByText('Анна')
    expect(screen.queryByText(/Матрица: персонажи/)).toBeNull()
  })
})

describe('EntitiesPanel — раскрытие блока (0.72.1)', () => {
  beforeEach(() => window.localStorage.clear())

  it('без карточек блок раскрыт по умолчанию: фичу иначе не находят', async () => {
    const { container } = panel()
    await screen.findByText(/Карточек пока нет/)
    expect((container.querySelector('[data-entities]') as HTMLDetailsElement).open).toBe(true)
  })

  it('с карточками блок закрыт, пока человек сам не раскроет', async () => {
    const { container } = panel({ entities: [entity()] })
    await screen.findByText('Анна')
    expect((container.querySelector('[data-entities]') as HTMLDetailsElement).open).toBe(false)
  })

  it('выбор запоминается для проекта', async () => {
    window.localStorage.setItem('skyfraze-entities-open:p1', '1')
    const { container } = panel({ entities: [entity()] })
    await screen.findByText('Анна')
    expect((container.querySelector('[data-entities]') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('EntitiesPanel — клетка матрицы ведёт в кадр (0.73.0)', () => {
  it('клик по числу открывает кадр и упоминание', async () => {
    const onOpenFrame = vi.fn()
    const mention = {
      entityId: 'e1',
      entityName: 'Анна',
      field: 'body' as const,
      from: 3,
      to: 7,
      quote: 'Анны',
    }
    panel({
      entities: [entity({ id: 'e1' })],
      onOpenFrame,
      matrix: {
        chapters: [{ id: 'ch1', title: 'Пролог', number: '01' }],
        rows: [
          {
            entity: { id: 'e1', name: 'Анна', aliases: [] },
            cells: [{ count: 2, first: { frameId: 'f9', mention } }],
            total: 2,
          },
        ],
      },
    })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '2' }))
    expect(onOpenFrame).toHaveBeenCalledWith('f9', expect.objectContaining({ quote: 'Анны' }))
  })
})
