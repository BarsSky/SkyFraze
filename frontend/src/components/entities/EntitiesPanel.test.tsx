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

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  addLink: vi.fn(),
  removeLink: vi.fn(),
}))

vi.mock('../../api/entities', async () => {
  const actual = await vi.importActual<typeof import('../../api/entities')>('../../api/entities')
  return {
    ...actual,
    createEntity: mocks.create,
    updateEntity: mocks.update,
    deleteEntity: mocks.remove,
    addEntityLink: mocks.addLink,
    deleteEntityLink: mocks.removeLink,
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
  mocks.addLink.mockReset().mockResolvedValue(undefined)
  mocks.removeLink.mockReset().mockResolvedValue(undefined)
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

  it('создание: имя, алиасы и описание уезжают на сервер, список перечитывается', async () => {
    mocks.create.mockResolvedValue(entity({ id: 'e9', name: 'Сторож', aliases: ['Сторожа'] }))
    const { reload } = panel()
    await screen.findByText(/Карточек пока нет/)

    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Сторож' } })
    fireEvent.change(screen.getByLabelText('Алиасы карточки'), { target: { value: 'Сторожа, ' } })
    fireEvent.change(screen.getByLabelText('Описание карточки'), {
      target: { value: '  молчаливый сторож  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Добавить/ }))

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('p1', {
        kind: 'character',
        name: 'Сторож',
        aliases: ['Сторожа'],
        description: 'молчаливый сторож',
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
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', { name: 'Анна', aliases: ['Аня', 'Аннушка'], description: '' }),
    )
    expect(await screen.findByText(/Изменения сохранены/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
  })

  /**
   * Переименование и текст (0.97.4). Упоминания ищутся по имени и алиасам, поэтому «Анна» → «Аня»
   * без старого имени в алиасах молча рвёт все связи карточки с кадрами, где написано «Анна».
   * Панель карточек текста не видит и спрашивает счётчик у владельца кадров.
   */
  it('переименование оставляет прежнее имя в алиасах, если оно есть в тексте', async () => {
    mocks.update.mockResolvedValue(entity({ name: 'Аня' }))
    const countMentionsOf = vi.fn().mockReturnValue(12)
    const { reload } = panel({ entities: [entity()], countMentionsOf })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Изменить карточку Анна'))
    fireEvent.change(screen.getByLabelText('Имя карточки Анна'), { target: { value: 'Аня' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', {
        name: 'Аня',
        aliases: ['Аня', 'Анна'],
        description: '',
      }),
    )
    expect(countMentionsOf).toHaveBeenCalledWith('Анна')
    // Сказать об этом обязательно: алиас добавлен без просьбы, и человек должен видеть, почему.
    expect(await screen.findByText(/Прежнее имя «Анна» оставлено в алиасах/)).toBeTruthy()
    expect(screen.getByText(/встречается 12 раз/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
  })

  it('если прежнего имени в тексте нет — алиасы не трогаем', async () => {
    mocks.update.mockResolvedValue(entity({ name: 'Аня' }))
    const countMentionsOf = vi.fn().mockReturnValue(0)
    panel({ entities: [entity()], countMentionsOf })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Изменить карточку Анна'))
    fireEvent.change(screen.getByLabelText('Имя карточки Анна'), { target: { value: 'Аня' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', {
        name: 'Аня',
        aliases: ['Аня'],
        description: '',
      }),
    )
    expect(screen.queryByText(/оставлено в алиасах/)).toBeNull()
  })

  it('прежнее имя уже в алиасах — второй раз не добавляем и не считаем', async () => {
    mocks.update.mockResolvedValue(entity({ name: 'Аня' }))
    const countMentionsOf = vi.fn().mockReturnValue(7)
    panel({
      entities: [entity({ aliases: ['Аня', 'анна'] })],
      countMentionsOf,
    })
    await screen.findByText('Анна')

    fireEvent.click(screen.getByLabelText('Изменить карточку Анна'))
    fireEvent.change(screen.getByLabelText('Имя карточки Анна'), { target: { value: 'Аня' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('p1', 'e1', {
        name: 'Аня',
        aliases: ['Аня', 'анна'],
        description: '',
      }),
    )
    expect(countMentionsOf).not.toHaveBeenCalled()
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
    expect(onOpenFrame).toHaveBeenCalledWith('f1', expect.objectContaining({ quote: 'Анны' }), 'editors')
  })

  it('без упоминаний кнопки «Где встречается» нет: раскрывать нечего', async () => {
    panel({ entities: [entity()], framesByEntity: { e1: [] } })
    await screen.findByText('Анна')
    expect(screen.queryByLabelText('Где встречается Анна')).toBeNull()
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

describe('EntitiesPanel — клетка матрицы раскрывает карточку упоминания (0.73.0 → 0.87.0)', () => {
  const mention = {
    entityId: 'e1',
    entityName: 'Анна',
    field: 'body' as const,
    from: 3,
    to: 7,
    quote: 'Анны',
  }
  const matrixWithCard = {
    chapters: [{ id: 'ch1', title: 'Пролог', number: '01' }],
    rows: [
      {
        entity: { id: 'e1', name: 'Анна', aliases: [] },
        cells: [
          {
            count: 3,
            first: { frameId: 'f9', mention },
            frames: [
              { id: 'f9', title: 'Встреча', mentions: 2, mention },
              { id: 'f10', title: 'Разговор', mentions: 1, mention },
            ],
          },
        ],
        total: 3,
      },
    ],
  }

  /**
   * 0.87.0: клик по числу больше не уводит молча — раскрывается карточка: глава, цитата, список
   * кадров главы и два перехода. Первая кнопка («К редактированию») ведёт в текст, вторая
   * («К проекту») — в показ проекта.
   */
  it('клик по числу раскрывает карточку: глава, кадры главы и цитата', async () => {
    const onOpenFrame = vi.fn()
    panel({ entities: [entity({ id: 'e1' })], onOpenFrame, matrix: matrixWithCard })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))

    const card = await screen.findByRole('region', { name: /Упоминания «Анна»/ })
    expect(card.textContent).toContain('глава 01')
    expect(card.textContent).toContain('Пролог')
    expect(card.textContent).toContain('Встреча')
    expect(card.textContent).toContain('Разговор')
    expect(card.textContent).toContain('«Анны»')
    // Прямого перехода по клику больше нет: сначала человек видит, куда идёт.
    expect(onOpenFrame).not.toHaveBeenCalled()
  })

  it('«К редактированию» ведёт в текст с кадром и упоминанием', async () => {
    const onOpenFrame = vi.fn()
    panel({ entities: [entity({ id: 'e1' })], onOpenFrame, matrix: matrixWithCard })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))
    // Выбираем второй кадр главы: переход должен вести именно в него.
    fireEvent.click(await screen.findByText('Разговор'))
    fireEvent.click(screen.getByRole('button', { name: 'К редактированию' }))

    expect(onOpenFrame).toHaveBeenCalledWith(
      'f10',
      expect.objectContaining({ quote: 'Анны' }),
      'editors',
    )
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('«К проекту» ведёт в показ проекта', async () => {
    const onOpenFrame = vi.fn()
    panel({ entities: [entity({ id: 'e1' })], onOpenFrame, matrix: matrixWithCard })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))
    fireEvent.click(screen.getByRole('button', { name: 'К проекту' }))
    expect(onOpenFrame).toHaveBeenCalledWith('f9', expect.objectContaining({ quote: 'Анны' }), 'project')
  })

  it('читателю доступен только переход к показу проекта', async () => {
    panel({ entities: [entity({ id: 'e1' })], canEdit: false, matrix: matrixWithCard, framesByEntity: {} })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))
    expect(screen.queryByRole('button', { name: 'К редактированию' })).toBeNull()
    expect(screen.getByRole('button', { name: 'К проекту' })).toBeTruthy()
  })

  it('Escape закрывает карточку', async () => {
    panel({ entities: [entity({ id: 'e1' })], matrix: matrixWithCard })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))
    await screen.findByRole('region')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region')).toBeNull()
  })

  /**
   * 0.90.0: карточка раскрывается В ПОТОКЕ под матрицей, а клетка помечается раскрытой.
   *
   * Отчёт: «элемент по клику показывает всплывающее сообщение, а не сам раскрывается в карточку».
   * Всплывающая карточка читалась как подсказка и на телефоне уезжала за край.
   */
  it('карточка стоит в разделе, а не всплывает поверх страницы', async () => {
    const { container } = panel({ entities: [entity({ id: 'e1' })], matrix: matrixWithCard })
    await screen.findAllByText('Анна')
    fireEvent.click(screen.getByText(/Матрица: персонажи × главы/))
    fireEvent.click(await screen.findByRole('button', { name: '3' }))
    const card = await screen.findByRole('region', { name: /Упоминания «Анна»/ })
    // Внутри блока карточек, а не порталом в body: это часть раздела.
    expect(container.contains(card)).toBe(true)
    expect(card.className).toContain('ent__mention-card')
    // Клетка сообщает, что она раскрыта, и подсвечена.
    const cell = container.querySelector('[data-matrix-cell]') as HTMLElement
    expect(cell.getAttribute('aria-expanded')).toBe('true')
    expect(cell.className).toContain('is-expanded')
    // Повторное нажатие сворачивает.
    fireEvent.click(cell)
    expect(screen.queryByRole('region')).toBeNull()
    expect(cell.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('EntitiesPanel — связи карточек (0.74.0)', () => {
  const anna = entity({ id: 'e1', name: 'Аня', aliases: [] })
  const earth = entity({ id: 'e2', name: 'Земля', aliases: [] })
  const link = {
    id: 'l1',
    from_entity: 'e1',
    to_entity: 'e2',
    label: 'живёт на',
    created_at: '2026-10-27T10:00:00Z',
  }

  it('чип показывает подпись и карточку на другом конце', async () => {
    panel({ entities: [anna, earth], links: [link] })
    await screen.findAllByText('Аня')
    expect(screen.getByText('→ живёт на')).toBeTruthy()
    // «Земля» есть и в карточке, и в чипе связи — проверяем, что чип её называет.
    expect(screen.getAllByText('Земля').length).toBeGreaterThan(1)
  })

  it('обратная сторона тоже видна: у Земли — «← живёт на · Аня»', async () => {
    panel({ entities: [anna, earth], links: [link] })
    await screen.findAllByText('Земля')
    expect(screen.getByText('← живёт на')).toBeTruthy()
  })

  it('читатель видит связь, но не может её убрать', async () => {
    panel({ entities: [anna, earth], links: [link], canEdit: false })
    await screen.findAllByText('Аня')
    expect(screen.queryByLabelText('Убрать связь с Земля')).toBeNull()
  })

  it('связи — список под подписью, и у каждой связи своя строка (0.97.2)', async () => {
    const third = entity({ id: 'e3', name: 'Сторож', aliases: [] })
    panel({
      entities: [anna, earth, third],
      links: [
        link,
        { ...link, id: 'l2', to_entity: 'e3', label: 'боится' },
      ],
    })
    await screen.findAllByText('Аня')
    // Подпись блока: раньше связи шли без неё и сливались с остальными полями карточки.
    // С 0.97.3 в подписи ещё и число связей — иначе свёрнутый список читался бы как полный.
    expect(screen.getAllByText(/^Связи/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Связи · 1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Связи · 2').length).toBeGreaterThan(0)
    // Каждая связь — отдельная строка списка (data-entity-link), а не общий поток чипов.
    const rows = document.querySelectorAll('[data-entity-link]')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      // У связи две стороны: у Ани — «→ живёт на», у Земли — «← живёт на». Важно, что у каждой
      // стороны своя строка и в ней есть подпись, а не только имя.
      expect(row.textContent).toMatch(/(→|←) (живёт на|боится)/)
    }
  })

  /**
   * Нагрузка (0.97.3): сервер разрешает до 20 связей у карточки, и в живом прогоне карточка с
   * двадцатью связями занимала 1033 px, а её кнопки уезжали на 1546 px от верха документа.
   * Теперь по умолчанию видно пять строк, остальные — за кнопкой с числом.
   */
  const manyLinks = (count: number) => {
    const hub = entity({ id: 'h1', name: 'Аня', aliases: [] })
    const others = Array.from({ length: count }, (_, index) =>
      entity({ id: `o${index}`, name: `Карточка ${index + 1}`, aliases: [] }),
    )
    const links = others.map((other, index) => ({
      id: `l${index}`,
      from_entity: hub.id,
      to_entity: other.id,
      label: 'живёт на',
      created_at: '2026-10-27T10:00:00Z',
    }))
    return { entities: [hub, ...others], links }
  }

  const cardOf = (name: string): HTMLElement => {
    const card = [...document.querySelectorAll('.ent__item')].find(
      (node) => node.querySelector('.ent__name')?.textContent === name,
    )
    if (!(card instanceof HTMLElement)) throw new Error(`нет карточки «${name}»`)
    return card
  }

  it('связей больше пяти: пять строк, счётчик и кнопка «Показать все» (0.97.3)', async () => {
    const data = manyLinks(8)
    panel(data)
    await screen.findAllByText('Аня')

    const card = cardOf('Аня')
    expect(card.querySelectorAll('[data-entity-link]').length).toBe(5)
    expect(card.querySelector('.ent__links-title')?.textContent).toBe('Связи · 8')
    const toggle = card.querySelector('[data-entity-links-toggle]')
    expect(toggle?.textContent).toBe('Показать все 8')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(card.querySelector('[data-entity-links-hidden]')?.textContent).toBe('скрыто ещё 3')
  })

  it('кнопка раскрывает все связи и сворачивает обратно (0.97.3)', async () => {
    const data = manyLinks(8)
    panel(data)
    await screen.findAllByText('Аня')

    const toggle = cardOf('Аня').querySelector('[data-entity-links-toggle]') as HTMLButtonElement
    fireEvent.click(toggle)
    const expanded = cardOf('Аня')
    expect(expanded.querySelectorAll('[data-entity-link]').length).toBe(8)
    expect(expanded.querySelector('[data-entity-links-toggle]')?.textContent).toBe('Свернуть связи')
    expect(expanded.querySelector('[data-entity-links-toggle]')?.getAttribute('aria-expanded')).toBe('true')
    // Раскрытый список не должен врать про скрытое.
    expect(expanded.querySelector('[data-entity-links-hidden]')).toBeNull()

    fireEvent.click(expanded.querySelector('[data-entity-links-toggle]') as HTMLButtonElement)
    expect(cardOf('Аня').querySelectorAll('[data-entity-link]').length).toBe(5)
  })

  it('свёрнутость — у каждой карточки своя: раскрытие одной не раскрывает другую (0.97.3)', async () => {
    const first = entity({ id: 'h1', name: 'Аня', aliases: [] })
    const second = entity({ id: 'h2', name: 'Земля', aliases: [] })
    const others = Array.from({ length: 12 }, (_, index) =>
      entity({ id: `o${index}`, name: `Карточка ${index + 1}`, aliases: [] }),
    )
    // По шесть связей на карточку: Ане — первые шесть целей, Земле — вторые шесть.
    const links = others.flatMap((other, index) => {
      const hub = index < 6 ? first : second
      return [
        {
          id: `l${index}`,
          from_entity: hub.id,
          to_entity: other.id,
          label: 'живёт на',
          created_at: '2026-10-27T10:00:00Z',
        },
      ]
    })
    panel({ entities: [first, second, ...others], links })
    await screen.findAllByText('Земля')

    expect(cardOf('Земля').querySelectorAll('[data-entity-link]').length).toBe(5)
    fireEvent.click(cardOf('Аня').querySelector('[data-entity-links-toggle]') as HTMLButtonElement)
    expect(cardOf('Аня').querySelectorAll('[data-entity-link]').length).toBe(6)
    expect(cardOf('Земля').querySelectorAll('[data-entity-link]').length).toBe(5)
  })
})

describe('EntitiesPanel — «связать» из карточки (0.76.0)', () => {
  const anna = entity({ id: 'e1', name: 'Аня', aliases: [] })
  const earth = entity({ id: 'e2', name: 'Земля', aliases: [], kind: 'place' })

  it('связь заводится из карточки: вторая карточка, подпись, перечитывание', async () => {
    const { reload } = panel({ entities: [anna, earth] })
    await screen.findAllByText('Аня')

    fireEvent.click(screen.getByLabelText('Связать карточку Аня'))
    // В списке выбора — только другие карточки: связать с собой нельзя (это и CHECK в БД).
    const target = screen.getByLabelText('С какой карточкой связать Аня') as HTMLSelectElement
    expect(Array.from(target.options).map((o) => o.value)).toEqual(['', 'e2'])

    fireEvent.change(target, { target: { value: 'e2' } })
    fireEvent.change(screen.getByLabelText('Подпись связи от Аня'), {
      target: { value: '  живёт на  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Связать' }))

    await waitFor(() => expect(mocks.addLink).toHaveBeenCalledWith('p1', 'e1', 'e2', 'живёт на'))
    expect(await screen.findByText(/Связь добавлена/)).toBeTruthy()
    expect(reload).toHaveBeenCalled()
    // Форма закрылась: иначе легко нажать «Связать» второй раз и получить 409.
    expect(screen.queryByLabelText('Подпись связи от Аня')).toBeNull()
  })

  it('без второй карточки кнопки нет: связывать не с чем', async () => {
    panel({ entities: [anna] })
    await screen.findAllByText('Аня')
    expect(screen.queryByLabelText('Связать карточку Аня')).toBeNull()
  })

  it('пока не выбраны карточка и подпись, кнопка неактивна', async () => {
    panel({ entities: [anna, earth] })
    await screen.findAllByText('Аня')
    fireEvent.click(screen.getByLabelText('Связать карточку Аня'))

    const save = screen
      .getAllByRole('button', { name: 'Связать' })
      .find((b) => b.hasAttribute('data-entity-link-save')) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('С какой карточкой связать Аня'), {
      target: { value: 'e2' },
    })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Подпись связи от Аня'), { target: { value: 'живёт на' } })
    expect(save.disabled).toBe(false)
  })

  it('ошибку сервера объясняет словами, а не кодом', async () => {
    mocks.addLink.mockRejectedValue({
      response: {
        clone: () => ({ json: async () => ({ error: 'такая связь уже есть' }) }),
      },
    })
    panel({ entities: [anna, earth] })
    await screen.findAllByText('Аня')
    fireEvent.click(screen.getByLabelText('Связать карточку Аня'))
    fireEvent.change(screen.getByLabelText('С какой карточкой связать Аня'), {
      target: { value: 'e2' },
    })
    fireEvent.change(screen.getByLabelText('Подпись связи от Аня'), { target: { value: 'живёт на' } })
    fireEvent.click(screen.getByRole('button', { name: 'Связать' }))
    expect(await screen.findByText('такая связь уже есть')).toBeTruthy()
  })

  it('читателю кнопки «связать» не показывают', async () => {
    panel({ entities: [anna, earth], canEdit: false })
    await screen.findAllByText('Аня')
    expect(screen.queryByLabelText('Связать карточку Аня')).toBeNull()
  })
})

describe('EntitiesPanel — свои типы карточек (0.81.0)', () => {
  const types = [
    { key: 'character', title: 'Герой', color: '', icon: '', position: 0, is_default: true, created_at: '' },
    { key: 'frakciya', title: 'Фракция', color: '', icon: '', position: 3, is_default: false, created_at: '' },
  ]

  it('в списке видов — типы проекта, включая свои', async () => {
    panel({ types })
    const select = (await screen.findByLabelText('Вид карточки')) as HTMLSelectElement
    const titles = Array.from(select.options).map((option) => option.textContent)
    expect(titles).toContain('Герой')
    expect(titles).toContain('Фракция')
  })

  it('подпись карточки берётся из типа проекта', async () => {
    const { container } = panel({
      types,
      entities: [entity({ id: 'f1', kind: 'frakciya', name: 'Дом Волка' })],
    })
    await screen.findByText('Дом Волка')
    // «Фракция» — не константа: это название типа в проекте. Проверяем именно подпись КАРТОЧКИ
    // (в списке видов то же слово — поэтому смотрим на строку карточки).
    const row = container.querySelector('.ent__item')
    expect(row?.querySelector('.ent__kind')?.textContent).toBe('Фракция')
  })

  it('«+ новый тип…» раскрывает форму и создаёт тип', async () => {
    const onCreateType = vi.fn().mockResolvedValue(undefined)
    panel({ types, onCreateType })
    fireEvent.change(await screen.findByLabelText('Вид карточки'), {
      target: { value: '__new_type__' },
    })
    const input = await screen.findByLabelText('Название нового типа')
    fireEvent.change(input, { target: { value: 'Артефакт' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать тип' }))
    await waitFor(() => expect(onCreateType).toHaveBeenCalledWith('Артефакт', { description: '', aliases: [] }))
    expect(await screen.findByText(/Тип «Артефакт» создан/)).toBeTruthy()
  })

  /**
   * Заготовка карточки у типа (0.85.0, docs/entity-types.md §4): «Порт: имя, алиасы, описание —
   * вот пустая заготовка, чтобы не писать одно и то же». Тип даёт название и цвет, заготовка —
   * предзаполненные поля.
   */
  it('заготовка типа подставляется в форму карточки, {{name}} — введённое имя', async () => {
    const withTemplate = types.map((item) =>
      item.key === 'frakciya'
        ? {
            ...item,
            card_template: {
              description: '{{name}} — союз городов на севере.',
              aliases: ['фракция', 'союз'],
            },
          }
        : item,
    )
    panel({ types: withTemplate })
    fireEvent.change(await screen.findByLabelText('Вид карточки'), { target: { value: 'frakciya' } })
    await waitFor(() =>
      expect((screen.getByLabelText('Алиасы карточки') as HTMLInputElement).value).toBe('фракция, союз'),
    )
    // Пока имени нет, подстановка оставляет {{name}} — видно, куда попадёт имя.
    const desc = screen.getByLabelText('Описание карточки') as HTMLTextAreaElement
    expect(desc.value).toContain('{{name}}')

    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Северный союз' } })
    await waitFor(() =>
      expect((screen.getByLabelText('Описание карточки') as HTMLTextAreaElement).value).toBe(
        'Северный союз — союз городов на севере.',
      ),
    )
  })

  it('правка описания руками отменяет подстановку заготовки', async () => {
    const withTemplate = types.map((item) =>
      item.key === 'character'
        ? { ...item, card_template: { description: '{{name}} — герой.', aliases: [] } }
        : item,
    )
    panel({ types: withTemplate })
    await screen.findByLabelText('Описание карточки')
    fireEvent.change(screen.getByLabelText('Описание карточки'), { target: { value: 'своё описание' } })
    fireEvent.change(screen.getByLabelText('Имя карточки'), { target: { value: 'Анна' } })
    // Заготовка не перетёрла написанное человеком.
    expect((screen.getByLabelText('Описание карточки') as HTMLTextAreaElement).value).toBe('своё описание')
  })

  it('заготовка типа из формы уходит на сервер вместе с названием', async () => {
    const onCreateType = vi.fn().mockResolvedValue(undefined)
    panel({ types, onCreateType })
    fireEvent.change(await screen.findByLabelText('Вид карточки'), {
      target: { value: '__new_type__' },
    })
    fireEvent.change(await screen.findByLabelText('Название нового типа'), {
      target: { value: 'Порт' },
    })
    fireEvent.change(screen.getByLabelText('Алиасы заготовки типа'), {
      target: { value: 'порт, гавань' },
    })
    fireEvent.change(screen.getByLabelText('Заготовка описания карточки типа'), {
      target: { value: '  {{name}} — порт.  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Создать тип' }))
    await waitFor(() =>
      expect(onCreateType).toHaveBeenCalledWith('Порт', {
        description: '{{name}} — порт.',
        aliases: ['порт', 'гавань'],
      }),
    )
  })

  it('без права создавать типы пункта «+ новый тип…» нет', async () => {
    panel({ types, canEdit: false })
    const select = (await screen.findByLabelText('Вид карточки').catch(() => null)) as HTMLSelectElement | null
    // Формы создания карточки у читателя нет вовсе — и создавать типы ему тоже нечем.
    expect(select).toBeNull()
  })
})
