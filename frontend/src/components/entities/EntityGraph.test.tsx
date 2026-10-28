import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntityGraph, shortLabel } from './EntityGraph'

/**
 * Подписи рёбер с холста. Ищем их в SVG, а не `getByText`: с 0.84.0 те же слова есть ещё и в
 * раскрытой карточке (там «← живёт на» — строка списка связей), и текстовый запрос находил бы
 * два элемента.
 */
function edgeLabels(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('[data-entity-graph-edge-label]')).map(
    (node) => node.textContent ?? '',
  )
}

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

  /**
   * 0.84.0: нажатие на соседа уводит его в ЦЕНТР и сразу раскрывает карточку со значениями
   * (заказ: «по выбору карточки — анимированный переход в центр с развёртыванием значений, так
   * всегда будет видно содержимое карточки»). До этого карточка раскрывалась сбоку, а переход был
   * отдельной кнопкой — на узком холсте боковая карточка лежала поверх соседей и центра.
   */
  it('клик по соседу уводит его в центр с раскрытой карточкой, «назад» возвращает', async () => {
    const view = render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    // Значения развёрнуты сразу — ещё до конца перелёта, поэтому содержимое не «мигает».
    expect(await screen.findByRole('dialog', { name: 'Карточка Земля' })).toBeTruthy()
    expect(document.querySelector('[data-entity-graph-fly]')).not.toBeNull()
    // После перелёта центр — Земля, связь читается в обратную сторону.
    await waitFor(() => expect(edgeLabels(view.container)).toEqual(['← живёт на']))
    expect(document.querySelector('[data-entity-graph-fly]')).toBeNull()
    // Карточка осталась открытой: содержимое видно и после перехода.
    expect(screen.getByRole('dialog', { name: 'Карточка Земля' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'назад' }))
    await waitFor(() => expect(edgeLabels(view.container)).toEqual(['→ живёт на']))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  /**
   * Карточка узла (0.78.0 → 0.84.0): по нажатию на «таблетку» видно, ТА ли это карточка и куда
   * ведут её связи. Карточка стоит в центре холста (0.84.0) — там же, куда приходит выбранный
   * узел, поэтому её не приходится читать «сквозь» граф.
   */
  it('карточка узла показывает вид, алиасы и ближайшие связи в центре холста', async () => {
    const annaWithAliases = { ...anna, aliases: ['Аня', 'Анну'] }
    const guard = { id: 'e3', kind: 'character' as const, name: 'Сторож', aliases: [], description: 'молчаливый', color: '', created_at: '', updated_at: '' }
    const toLetter = { id: 'l2', from_entity: 'e1', to_entity: 'e3', label: 'боится', created_at: '' }
    render(<EntityGraph entities={[annaWithAliases, earth, guard]} links={[link, toLetter]} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Аня' }))
    const card = await screen.findByRole('dialog', { name: 'Карточка Аня' })
    expect(card.className).toContain('egraph__card--center')
    expect(card.textContent).toContain('Персонаж')
    expect(card.textContent).toContain('также: Аня, Анну')
    expect(card.textContent).toContain('связей: 2')
    expect(card.textContent).toContain('живёт на')
    expect(card.textContent).toContain('Земля')
    expect(card.textContent).toContain('боится')
    // Отдельной кнопки «Сделать центром» больше нет: выбранная карточка уже в центре.
    expect(screen.queryByRole('button', { name: 'Сделать центром' })).toBeNull()
  })

  it('при «меньше движения» переход мгновенный: без перелетающей пилюли', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }))
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    // Центр сменился сразу, перелёта нет — но карточка открыта.
    expect(edgeLabels(document.body)).toEqual(['← живёт на'])
    expect(document.querySelector('[data-entity-graph-fly]')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Карточка Земля' })).toBeTruthy()
  })

  /**
   * Разрыв в линии под подписью (0.84.0). Подпись раньше лежала поверх линии на «плашке» цвета
   * фона — на градиенте холста это читалось как замазка, а длинная подпись — как обрубок связи.
   */
  it('линия рвётся там, где стоит подпись: две половины ребра, а не одна', async () => {
    const view = render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    await screen.findByRole('button', { name: 'Аня' })
    const pieces = view.container.querySelectorAll('line.egraph__edge')
    expect(pieces).toHaveLength(2)
    const [before, after] = Array.from(pieces)
    const beforeEnd = Number(before.getAttribute('x2'))
    const afterStart = Number(after.getAttribute('x1'))
    expect(afterStart).toBeGreaterThan(beforeEnd)
    // Подпись — ровно в промежутке.
    const label = view.container.querySelector('[data-entity-graph-edge-label]')
    expect(label).not.toBeNull()
    expect(Number(label?.getAttribute('x'))).toBeGreaterThan(beforeEnd)
    expect(Number(label?.getAttribute('x'))).toBeLessThan(afterStart + 1)
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
    const view = render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    const search = await screen.findByLabelText('Поиск по карточкам в графе')
    fireEvent.change(search, { target: { value: 'зем' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(edgeLabels(view.container)).toEqual(['← живёт на']))
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

/**
 * Уровни графа и поиск по меткам (0.100.0).
 *
 * Заказ: «как группировать карточки и ориентироваться в них, с акцентом на главную группу и
 * погружением в подгруппы; поиск должен выдавать подсказками проиндексированные метки карточек».
 * Решения из отчёта: главная группа — созданная первой; глубина — без верхней границы; свайп —
 * пробный.
 */
describe('EntityGraph — мир, группы и поиск по меткам (0.100.0)', () => {
  const card = (id: string, name: string, kind = 'character') => ({
    id,
    kind,
    name,
    aliases: [] as string[],
    description: '',
    color: '',
    created_at: '',
    updated_at: '',
  })
  const anna = { ...card('e1', 'Аня'), aliases: ['Анна'] }
  const earth = card('e2', 'Земля', 'place')
  const bob = card('e3', 'Борис')
  // Типы: «Место» создан раньше «Персонажа» — значит, главная группа именно «Место».
  const types = [
    { key: 'place', title: 'Место', color: '', icon: '', position: 2, is_default: true, created_at: '2026-01-01T00:00:00Z' },
    { key: 'character', title: 'Персонаж', color: '', icon: '', position: 1, is_default: true, created_at: '2026-02-01T00:00:00Z' },
  ]
  const links = [
    { id: 'l1', from_entity: 'e1', to_entity: 'e2', label: 'живёт на', created_at: '' },
    { id: 'l2', from_entity: 'e1', to_entity: 'e3', label: 'боится', created_at: '' },
  ]

  it('уровень «мир»: группы по видам, главная — созданная первой', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Мир' }))
    const groups = document.querySelectorAll('[data-entity-graph-group]')
    expect(groups).toHaveLength(2)
    // Первая по порядку — та, чей тип создан раньше, и у неё акцент.
    expect(groups[0].getAttribute('data-entity-graph-group')).toBe('place')
    expect(groups[0].className).toContain('is-main')
    expect(groups[1].className).not.toContain('is-main')
    // У группы видно число карточек и связей.
    expect(groups[0].textContent).toContain('Земля'.length ? '1' : '1')
    // Связи считаются по карточкам группы: у Ани две, у Бориса одна — итого три.
    expect(groups[1].textContent).toContain('связей 3')
  })

  it('вход в группу показывает подгруппы по подписям связей (0.101.0)', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Мир' }))
    fireEvent.click(screen.getByRole('button', { name: /Группа «Персонаж»/ }))

    const labels = Array.from(document.querySelectorAll('[data-entity-graph-cluster]')).map((node) =>
      node.getAttribute('data-entity-graph-cluster'),
    )
    expect(labels).toEqual(['боится', 'живёт на'])
    // В «живёт на» — только Аня (второй конец связи в другой группе), в «боится» — Аня и Борис.
    const ziv = document.querySelector('[data-entity-graph-cluster="живёт на"]') as HTMLElement
    const boitsya = document.querySelector('[data-entity-graph-cluster="боится"]') as HTMLElement
    expect(ziv.querySelectorAll('[data-entity-graph-group-card]')).toHaveLength(1)
    expect(boitsya.querySelectorAll('[data-entity-graph-group-card]')).toHaveLength(2)
    // У строки видно, с кем связь: «→ Земля», «← Аня».
    expect(ziv.textContent).toContain('→ Земля')
    expect(boitsya.textContent).toContain('← Аня')

    // Подгруппа сворачивается: это состояние просмотра, а не настройка.
    fireEvent.click(ziv.querySelector('[data-entity-graph-cluster-toggle]') as HTMLButtonElement)
    expect(ziv.querySelector('[data-entity-graph-cluster-toggle]')?.getAttribute('aria-expanded')).toBe('false')
    expect(ziv.querySelectorAll('[data-entity-graph-group-card]')).toHaveLength(0)

    // Карточка из подгруппы открывается в обозревателе.
    fireEvent.click(boitsya.querySelectorAll('[data-entity-graph-group-card]')[1] as HTMLButtonElement)
    expect(await screen.findByRole('dialog', { name: 'Карточка Борис' })).toBeTruthy()
  })

  it('карточка без связей попадает в подгруппу «вне связей»', async () => {
    const lonely = card('e9', 'Сторож')
    render(<EntityGraph entities={[anna, earth, bob, lonely]} links={links} types={types} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Мир' }))
    fireEvent.click(screen.getByRole('button', { name: /Группа «Персонаж»/ }))
    const isolated = document.querySelector('[data-entity-graph-cluster="isolated"]') as HTMLElement
    expect(isolated.textContent).toContain('вне связей')
    expect(isolated.textContent).toContain('Сторож')
    expect(isolated.textContent).toContain('связей нет')
  })

  it('поиск находит по алиасу и объясняет, почему карточка в выдаче', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    const input = await screen.findByLabelText('Поиск по карточкам в графе')
    fireEvent.change(input, { target: { value: 'анна' } })
    // «Аня» есть и узлом на холсте, и подсказкой — берём именно подсказку.
    const hit = (await waitFor(() => {
      const node = document.querySelector('[data-entity-graph-match]') as HTMLElement | null
      if (node === null) throw new Error('нет подсказок')
      return node
    })) as HTMLElement
    expect(hit.getAttribute('data-entity-graph-match-source')).toBe('alias')
    expect(hit.textContent).toContain('алиас «Анна»')
  })

  it('поиск по подписи связи находит обе стороны', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    fireEvent.change(await screen.findByLabelText('Поиск по карточкам в графе'), { target: { value: 'живёт' } })
    const hits = document.querySelectorAll('[data-entity-graph-match]')
    const names = Array.from(hits).map((node) => node.textContent ?? '')
    expect(names.some((text) => text.includes('Аня'))).toBe(true)
    expect(names.some((text) => text.includes('Земля'))).toBe(true)
    expect(names.some((text) => text.includes('связь «живёт на»'))).toBe(true)
  })

  it('«глубже» показывает уровни окрестности, пока есть что показывать', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    // Центр — Аня (у неё больше связей): прямых соседей двое, глубже идти некуда.
    await screen.findByRole('button', { name: 'Аня' })
    expect(document.querySelector('[data-entity-graph-deeper]')).toBeNull()
    // Переходим на «Землю»: у неё сосед Аня, а за Аней — Борис, то есть «глубже» есть.
    fireEvent.click(screen.getByRole('button', { name: 'Земля' }))
    await waitFor(() => expect(document.querySelector('[data-entity-graph-deeper]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-entity-graph-deeper]') as HTMLButtonElement)
    const levels = document.querySelectorAll('[data-entity-graph-level]')
    expect(levels.length).toBeGreaterThan(0)
    expect(levels[0].textContent).toContain('уровень 2')
    // «Свернуть» возвращает к прямому окружению.
    fireEvent.click(document.querySelector('[data-entity-graph-flatter]') as HTMLButtonElement)
    expect(document.querySelectorAll('[data-entity-graph-level]')).toHaveLength(0)
  })

  it('группы листаются стрелками; свайпа нет — жест отдан прокрутке страницы (0.102.0)', async () => {
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Мир' }))
    fireEvent.click(screen.getByRole('button', { name: /Группа «Место»/ }))
    const cards = () =>
      document
        .querySelector('[data-entity-graph-group-cards]')
        ?.getAttribute('data-entity-graph-group-cards')
    expect(cards()).toBe('place')
    // Касание влево больше ничего не листает: свайп убран, потому что на телефоне не срабатывал.
    const list = document.querySelector('[data-entity-graph-group-cards]') as HTMLElement
    fireEvent.touchStart(list, { touches: [{ clientX: 200 }] })
    fireEvent.touchEnd(list, { changedTouches: [{ clientX: 100 }] })
    expect(cards()).toBe('place')
    fireEvent.click(document.querySelector('[data-entity-graph-group-next]') as HTMLButtonElement)
    await waitFor(() => expect(cards()).toBe('character'))
    fireEvent.click(document.querySelector('[data-entity-graph-group-prev]') as HTMLButtonElement)
    await waitFor(() => expect(cards()).toBe('place'))
  })

  it('запоминает уровень: вернувшись, человек попадает в ту же группу (0.101.0)', async () => {
    localStorage.clear()
    const first = render(
      <EntityGraph entities={[anna, earth, bob]} links={links} types={types} projectId="p-zapomnit" />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Мир' }))
    fireEvent.click(screen.getByRole('button', { name: /Группа «Персонаж»/ }))
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('skyfraze-graph-view:p-zapomnit') ?? '{}').groupKind).toBe(
        'character',
      ),
    )
    first.unmount()

    // Повторный заход в тот же проект открывается на той же группе, а не на карточке по умолчанию.
    render(<EntityGraph entities={[anna, earth, bob]} links={links} types={types} projectId="p-zapomnit" />)
    await waitFor(() =>
      expect(
        document.querySelector('[data-entity-graph-group-cards]')?.getAttribute('data-entity-graph-group-cards'),
      ).toBe('character'),
    )
    localStorage.clear()
  })
})
