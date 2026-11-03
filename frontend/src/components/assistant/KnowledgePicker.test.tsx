import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KnowledgePicker, MAX_KNOWLEDGE_ATTACH } from './KnowledgePicker'
import { setLang } from '../../store/lang'

/**
 * Выбор знаний к сообщению (0.149.0).
 *
 * Проверяем предел и состояние: к одному вопросу — не больше десяти знаний, уже выбранные
 * отмечены при открытии, а «Приложить» отдаёт ровно выбранное. Ошибка здесь тихая: уйдёт
 * больше знаний, чем влезает в контекст, и модель получит отказ вместо ответа.
 */

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../api/assistant', () => ({
  listAIKnowledge: mocks.list,
}))

vi.mock('../../api/client', () => ({
  serverErrorMessage: mocks.error,
}))

const brief = (index: number) => ({
  id: `k${index}`,
  title: `Знание ${index}`,
  summary: '',
  chars: 10,
  authorName: '',
  createdAt: '2026-03-01T10:00:00Z',
  updatedAt: '2026-03-01T10:00:00Z',
})

beforeEach(() => {
  setLang('ru')
  mocks.list.mockReset()
  mocks.error.mockReset()
  mocks.error.mockResolvedValue(null)
  mocks.list.mockResolvedValue(Array.from({ length: 12 }, (_, i) => brief(i + 1)))
})

afterEach(() => cleanup())

describe('KnowledgePicker', () => {
  it('закрыт — ничего не показывает', () => {
    render(
      <KnowledgePicker projectId="p1" open={false} onClose={() => {}} selected={[]} onConfirm={() => {}} />,
    )
    expect(document.querySelector('[data-knowledge-picker]')).toBeNull()
  })

  it('отдаёт выбранные знания по кнопке «Приложить»', async () => {
    const onConfirm = vi.fn()
    render(
      <KnowledgePicker projectId="p1" open onClose={() => {}} selected={[]} onConfirm={onConfirm} />,
    )
    const first = (await waitFor(() => {
      const found = document.querySelector('[data-knowledge-picker-item="k1"]') as HTMLInputElement | null
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })) as HTMLInputElement
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('button', { name: 'Приложить' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual(['k1'])
  })

  it('не даёт выбрать больше десяти знаний', async () => {
    render(
      <KnowledgePicker projectId="p1" open onClose={() => {}} selected={[]} onConfirm={() => {}} />,
    )
    await waitFor(() =>
      expect(document.querySelector('[data-knowledge-picker-item="k12"]')).not.toBeNull(),
    )
    for (let i = 1; i <= MAX_KNOWLEDGE_ATTACH; i += 1) {
      fireEvent.click(document.querySelector(`[data-knowledge-picker-item="k${i}"]`) as Element)
    }
    // Одиннадцатое знание уже не отмечается: предел тот же, что у сервера.
    fireEvent.click(document.querySelector('[data-knowledge-picker-item="k11"]') as Element)
    const checked = Array.from(
      document.querySelectorAll<HTMLInputElement>('[data-knowledge-picker-item]'),
    ).filter((input) => input.checked)
    expect(checked).toHaveLength(MAX_KNOWLEDGE_ATTACH)
    expect(checked.some((input) => input.dataset.knowledgePickerItem === 'k11')).toBe(false)
  })

  it('уже приложенные знания отмечены при открытии', async () => {
    render(
      <KnowledgePicker
        projectId="p1"
        open
        onClose={() => {}}
        selected={[brief(2)]}
        onConfirm={() => {}}
      />,
    )
    const second = (await waitFor(() => {
      const found = document.querySelector('[data-knowledge-picker-item="k2"]') as HTMLInputElement | null
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })) as HTMLInputElement
    expect(second.checked).toBe(true)
  })
})
