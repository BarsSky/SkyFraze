import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EntityGraph, shortLabel } from './EntityGraph'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('EntityGraph — эго-граф связей (0.75.0)', () => {
  const anna = { id: 'e1', kind: 'character' as const, name: 'Аня', aliases: [], description: '', color: '', created_at: '', updated_at: '' }
  const earth = { id: 'e2', kind: 'place' as const, name: 'Земля', aliases: [], description: '', color: '', created_at: '', updated_at: '' }
  const link = { id: 'l1', from_entity: 'e1', to_entity: 'e2', label: 'живёт на', created_at: '' }

  it('центр по умолчанию — карточка с наибольшим числом связей, сосед виден', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    expect(await screen.findByText('Аня')).toBeTruthy()
    expect(screen.getByText('Земля')).toBeTruthy()
    // Подпись ребра: направление и текст связи.
    expect(screen.getByText('→ живёт на')).toBeTruthy()
  })

  it('клик по соседу раскрывает карточку, «Сделать центром» центрирует, «назад» возвращает', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    // Нажатие на узел больше НЕ перескакивает: сначала карточка, переход — отдельной кнопкой.
    expect(await screen.findByRole('dialog', { name: 'Карточка Земля' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сделать центром' }))
    // Теперь центр — Земля, а её сосед — Аня (обратная сторона связи).
    expect(await screen.findByText('← живёт на')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'назад' }))
    expect(await screen.findByText('→ живёт на')).toBeTruthy()
  })

  /**
   * Карточка узла (0.78.0): по нажатию на «таблетку» видно, ТА ли это карточка и куда ведут её
   * связи. Раньше таблетка сообщала только имя, а нажатие сразу уводило в другую карточку.
   */
  it('карточка узла показывает вид, алиасы и ближайшие связи', async () => {
    const annaWithAliases = { ...anna, aliases: ['Аня', 'Анну'] }
    const guard = { id: 'e3', kind: 'character' as const, name: 'Сторож', aliases: [], description: 'молчаливый', color: '', created_at: '', updated_at: '' }
    const toLetter = { id: 'l2', from_entity: 'e1', to_entity: 'e3', label: 'боится', created_at: '' }
    render(<EntityGraph entities={[annaWithAliases, earth, guard]} links={[link, toLetter]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Аня' }))
    const card = await screen.findByRole('dialog', { name: 'Карточка Аня' })
    expect(card.textContent).toContain('Персонаж')
    expect(card.textContent).toContain('также: Аня, Анну')
    expect(card.textContent).toContain('связей: 2')
    expect(card.textContent).toContain('живёт на')
    expect(card.textContent).toContain('Земля')
    expect(card.textContent).toContain('боится')
    // Центр карточкой не переключается: перехода тут нет.
    expect(screen.queryByRole('button', { name: 'Сделать центром' })).toBeNull()
  })

  it('Escape и «×» закрывают карточку', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    expect(await screen.findByRole('dialog', { name: 'Карточка Земля' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Карточка Земля' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Земля' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Закрыть карточку' }))
    expect(screen.queryByRole('dialog', { name: 'Карточка Земля' })).toBeNull()
  })

  it('карточка без алиасов говорит об этом словами, а не пустотой', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    const card = await screen.findByRole('dialog', { name: 'Карточка Земля' })
    expect(card.textContent).toContain('алиасов нет')
  })

  /**
   * Карточки вне эго-графа (0.81.0): добавленная карточка без связей не появлялась в графе, и
   * это выглядело как «область не обновилась после создания». Теперь они видны строкой и по
   * нажатию становятся центром.
   */
  it('карточки без связей видны строкой и становятся центром по нажатию', async () => {
    const lonely = { id: 'e4', kind: 'character' as const, name: 'Мельник', aliases: [], description: '', color: '', created_at: '', updated_at: '' }
    render(<EntityGraph entities={[anna, earth, lonely]} links={[link]} />)
    expect(await screen.findByText(/вне связей: 1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Мельник' }))
    // Центр переключился: у Мельника связей нет, и об этом сказано словами.
    expect(await screen.findByText(/У карточки пока нет связей/)).toBeTruthy()
  })

  it('поиск находит карточку и Enter центрирует её', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    const search = await screen.findByLabelText('Поиск по карточкам в графе')
    fireEvent.change(search, { target: { value: 'зем' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(await screen.findByText('← живёт на')).toBeTruthy()
  })

  it('карточка без связей объясняет, где их завести', async () => {
    render(<EntityGraph entities={[anna]} links={[]} />)
    expect(await screen.findByText(/нет связей/)).toBeTruthy()
  })

  it('без карточек граф не рисуется, но объясняет почему', () => {
    render(<EntityGraph entities={[]} links={[]} />)
    expect(screen.getByText(/Граф появится/)).toBeTruthy()
  })

  /**
   * Регрессия, найденная живой проверкой 0.77.0: две связи между одной парой карточек давали
   * ДВА узла с одинаковым id («два ребёнка с одним ключом» в консоли, узлы рисуются друг на
   * друге, у «соседей» завышенное число). Карточка — один узел; подписи соединяются.
   */
  it('две связи между одной парой — один узел и обе подписи', async () => {
    const second = { id: 'l2', from_entity: 'e1', to_entity: 'e2', label: 'получает', created_at: '' }
    render(<EntityGraph entities={[anna, earth]} links={[link, second]} />)
    await screen.findByRole('button', { name: 'Аня' })
    expect(screen.getAllByRole('button', { name: 'Земля' })).toHaveLength(1)
    expect(screen.getByText('→ живёт на · получает')).toBeTruthy()
  })

  /**
   * Регрессия, найденная живой проверкой 0.77.0: карточки приходят с сервера ПОСЛЕ первого
   * рендера, и до них холста в дереве нет. Пока размер мерился эффектом с пустыми
   * зависимостями, наблюдатель создавался при `hostRef.current === null` и больше не создавался
   * никогда — раскладка оставалась в размере по умолчанию (720×340). На широком экране это
   * «граф прижат влево и пустует», на телефоне (холст 318 px) узлы уезжали за край, и граф
   * выглядел пустым.
   */
  it('раскладка считает по РЕАЛЬНОМУ размеру холста, даже если карточки пришли позже', async () => {
    // jsdom не считает геометрию: подменяем замер, как его видит компонент.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      toJSON: () => ({}),
    } as DOMRect)

    const view = render(<EntityGraph entities={[]} links={[]} />)
    expect(screen.getByText(/Граф появится/)).toBeTruthy()
    // Карточки пришли после первого рендера — холст появляется только теперь.
    view.rerender(<EntityGraph entities={[anna, earth]} links={[link]} />)

    const center = await screen.findByRole('button', { name: 'Аня' })
    const left = Number.parseFloat(center.style.left)
    // Центр эллипса — половина ШИРИНЫ ХОЛСТА (400 / 2), а не половина 720 по умолчанию.
    expect(left).toBe(200)
    const neighbor = screen.getByRole('button', { name: 'Земля' })
    expect(Number.parseFloat(neighbor.style.left)).toBeLessThanOrEqual(400)
  })
})

describe('shortLabel — подпись ребра на холсте (0.78.0)', () => {
  it('короткая подпись остаётся целой', () => {
    expect(shortLabel('→ живёт на')).toBe('→ живёт на')
  })

  it('длинная обрезается: подпись не вылезает за холст (замер: 366 px текста в 292 px холсте)', () => {
    const long = '→ перехвачено · проверка связи · проверка 16:35:34 · проверка 16:35:54'
    const short = shortLabel(long)
    expect(short.length).toBeLessThanOrEqual(22)
    expect(short.endsWith('…')).toBe(true)
    // Обрезка по границе слова: «провер…» читается хуже, чем «проверка…».
    expect(short).not.toMatch(/\s…$/)
  })
})
