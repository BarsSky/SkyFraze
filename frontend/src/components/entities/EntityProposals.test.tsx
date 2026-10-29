import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EntityProposals, describeResult } from './EntityProposals'
import { setLang } from '../../store/lang'
import type { AIEntityProposal } from '../../api/assistant'

/**
 * Предложения карточек мира от помощника (0.77.0).
 *
 * Что проверяем и почему: главное обещание — карточки появляются ТОЛЬКО по кнопке, а человек
 * видит, что именно появилось. Поэтому тесты смотрят на аргументы вызова сервера, на отчёт
 * после применения и на то, что «Не надо» ничего не создаёт.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn(),
  notify: vi.fn(),
}))

vi.mock('../../api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../api/assistant')>('../../api/assistant')
  return {
    ...actual,
    listAIEntityProposals: mocks.list,
    applyAIEntityProposal: mocks.apply,
    discardAIEntityProposal: mocks.discard,
    notifyEntitiesChanged: mocks.notify,
  }
})

const proposal = (over: Partial<AIEntityProposal> = {}): AIEntityProposal => ({
  id: 'p1',
  status: 'pending',
  note: 'в главе появились новые герои',
  cards: [
    { kind: 'character', name: 'Анна', aliases: ['Аня', 'Анну'], description: 'главная героиня' },
    { kind: 'place', name: 'Земля', aliases: [], description: '' },
  ],
  links: [{ from: 'Анна', to: 'Земля', label: 'живёт на' }],
  createdAt: '2026-10-27T10:00:00Z',
  ...over,
})

beforeEach(() => {
  setLang('ru')
  mocks.list.mockReset().mockResolvedValue([])
  mocks.apply.mockReset()
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.notify.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('EntityProposals', () => {
  it('показывает состав предложения: карточки, алиасы, связи и пояснение', async () => {
    mocks.list.mockResolvedValue([proposal()])
    const { container } = render(<EntityProposals projectId="proj" />)

    expect(await screen.findByText('Анна')).toBeTruthy()
    expect(screen.getByText('Земля')).toBeTruthy()
    expect(screen.getByText('(Аня, Анну)')).toBeTruthy()
    expect(screen.getByText('главная героиня')).toBeTruthy()
    expect(screen.getByText('в главе появились новые герои')).toBeTruthy()
    // Связь читается словами: подпись принадлежит связи, без обоих концов — половина.
    expect(screen.getByText('живёт на', { exact: false })).toBeTruthy()
    expect(container.querySelector('[data-entity-proposal="p1"]')).toBeTruthy()
  })

  it('без предложений блок не рисуется вовсе', async () => {
    mocks.list.mockResolvedValue([])
    const { container } = render(<EntityProposals projectId="proj" />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('proj'))
    expect(container.querySelector('[data-entity-proposals]')).toBeNull()
  })

  it('«Добавить карточки» создаёт их на сервере и сообщает панели связей', async () => {
    mocks.list.mockResolvedValue([proposal()])
    mocks.apply.mockResolvedValue({
      proposal: proposal({ status: 'applied' }),
      result: {
        created: ['Анна', 'Земля'],
        existing: [],
        failed: [],
        linksCreated: ['Анна → живёт на → Земля'],
        linksSkipped: [],
      },
    })
    render(<EntityProposals projectId="proj" />)

    fireEvent.click(await screen.findByText('Добавить карточки'))

    await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith('proj', 'p1'))
    expect(mocks.notify).toHaveBeenCalled()
    // Отчёт словами: по числу нельзя понять, та ли это «Анна».
    expect(await screen.findByText(/добавлено: Анна, Земля/)).toBeTruthy()
    // Предложение ушло из списка: применять его второй раз нельзя (409).
    await waitFor(() =>
      expect(screen.queryByText('Добавить карточки')).toBeNull(),
    )
  })

  it('занятое имя — не ошибка, а строка отчёта «уже было»', async () => {
    mocks.list.mockResolvedValue([proposal()])
    mocks.apply.mockResolvedValue({
      proposal: proposal({ status: 'applied' }),
      result: {
        created: ['Земля'],
        existing: ['Анна'],
        failed: [],
        linksCreated: [],
        linksSkipped: [],
      },
    })
    render(<EntityProposals projectId="proj" />)
    fireEvent.click(await screen.findByText('Добавить карточки'))
    expect(await screen.findByText(/добавлено: Земля · уже было: Анна/)).toBeTruthy()
  })

  it('«Не надо» ничего не создаёт и не трогает панель связей', async () => {
    mocks.list.mockResolvedValue([proposal()])
    render(<EntityProposals projectId="proj" />)

    fireEvent.click(await screen.findByText('Не надо'))

    await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith('proj', 'p1'))
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(await screen.findByText(/в проекте ничего не изменилось/)).toBeTruthy()
  })

  it('отказ сервера показывается словами, а не кодом', async () => {
    mocks.list.mockResolvedValue([proposal()])
    mocks.apply.mockRejectedValue({
      response: {
        clone: () => ({ json: async () => ({ error: 'нет прав на изменение этого проекта' }) }),
      },
    })
    render(<EntityProposals projectId="proj" />)
    fireEvent.click(await screen.findByText('Добавить карточки'))
    expect(await screen.findByText('нет прав на изменение этого проекта')).toBeTruthy()
    // Предложение осталось: человек может позвать владельца и нажать ещё раз.
    expect(screen.getByText('Добавить карточки')).toBeTruthy()
  })

  it('новый ответ помощника перечитывает список', async () => {
    mocks.list.mockResolvedValue([])
    const view = render(<EntityProposals projectId="proj" refreshKey={0} />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))

    mocks.list.mockResolvedValue([proposal()])
    view.rerender(<EntityProposals projectId="proj" refreshKey={1} />)
    expect(await screen.findByText('Анна')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
})

describe('describeResult', () => {
  const empty = { created: [], existing: [], failed: [], linksCreated: [], linksSkipped: [] }

  it('перечисляет имена, а не количество', () => {
    expect(describeResult({ ...empty, created: ['Анна', 'Земля'] })).toBe('добавлено: Анна, Земля')
  })

  it('объясняет пропуски с причиной', () => {
    const text = describeResult({
      ...empty,
      linksSkipped: [{ name: 'Анна → летит на → Марс', reason: 'карточки «Марс» нет в проекте' }],
    })
    expect(text).toContain('связи пропущены')
    expect(text).toContain('Марс')
  })

  it('пустой итог говорит словами, а не пустой строкой', () => {
    expect(describeResult(empty)).toMatch(/ничего не изменилось/)
  })

  it('на английском отчёт переведён', () => {
    const en = { ...empty, created: ['Анна'], linksCreated: ['a'] }
    expect(describeResult(en, 'en')).toBe('added: Анна · links: 1')
    expect(describeResult(en, 'ru')).toBe('добавлено: Анна · связей: 1')
  })
})

describe('EntityProposals — язык', () => {
  it('на английском переводит подписи и склоняет по числам', async () => {
    setLang('en')
    mocks.list.mockResolvedValue([proposal()])
    render(<EntityProposals projectId="proj" />)

    expect(await screen.findByText('The assistant suggests cards')).toBeTruthy()
    expect(screen.getByText(/· 2 cards/)).toBeTruthy()
    expect(screen.getByText(/· 1 link/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add cards' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
  })
})
