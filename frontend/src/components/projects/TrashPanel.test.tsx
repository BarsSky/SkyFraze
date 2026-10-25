import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TrashPanel } from './TrashPanel'
import type { TrashedProject } from '../../api/projects'

/**
 * Корзина проектов.
 *
 * Проверяем обещание, а не разметку: «вернуть можно ещё N дней» обязано быть на экране,
 * «навсегда» — отдельной кнопкой, и пустая корзина должна говорить, что она пуста, а не
 * выглядеть сломанной.
 */

const project = (over: Partial<TrashedProject> = {}): TrashedProject => ({
  id: 'p1',
  title: 'Рукопись',
  description: '',
  deleted_at: '2026-10-01T10:00:00Z',
  days_left: 30,
  ...over,
})

afterEach(cleanup)

describe('TrashPanel', () => {
  it('показывает срок хранения и остаток дней', () => {
    render(
      <TrashPanel
        items={[project({ days_left: 30 })]}
        retentionDays={30}
        busyId={null}
        onRestore={() => undefined}
        onPurge={() => undefined}
      />,
    )
    expect(screen.getByText('Корзина')).toBeTruthy()
    // Срок — обещание: он написан и в шапке, и у самого проекта.
    expect(screen.getByText(/Удалённое хранится 30 дней/)).toBeTruthy()
    expect(screen.getByText(/вернуть можно ещё 30 дней/)).toBeTruthy()
  })

  it('склоняет остаток и не обещает возврат после срока', () => {
    const { rerender } = render(
      <TrashPanel items={[project({ days_left: 1 })]} retentionDays={30} busyId={null}
        onRestore={() => undefined} onPurge={() => undefined} />,
    )
    expect(screen.getByText(/вернуть можно ещё 1 день/)).toBeTruthy()

    rerender(
      <TrashPanel items={[project({ days_left: 0 })]} retentionDays={30} busyId={null}
        onRestore={() => undefined} onPurge={() => undefined} />,
    )
    expect(screen.getByText(/срок восстановления истёк/)).toBeTruthy()
  })

  it('возврат и окончательное удаление — разные кнопки', () => {
    const onRestore = vi.fn()
    const onPurge = vi.fn()
    render(
      <TrashPanel items={[project()]} retentionDays={30} busyId={null}
        onRestore={onRestore} onPurge={onPurge} />,
    )
    // Ошибка в этом месте необратима: «удалить навсегда» не должно быть тем же
    // нажатием, что «вернуть».
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onPurge).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0][0].id).toBe('p1')
    expect(onPurge.mock.calls[0][0].id).toBe('p1')
  })

  it('пустая корзина говорит об этом и не рисует кнопок', () => {
    render(
      <TrashPanel items={[]} retentionDays={30} busyId={null}
        onRestore={() => undefined} onPurge={() => undefined} />,
    )
    expect(screen.getByText(/Пусто\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Вернуть' })).toBeNull()
  })

  it('во время запроса кнопки не нажимаются повторно', () => {
    const onRestore = vi.fn()
    render(
      <TrashPanel items={[project()]} retentionDays={30} busyId="p1"
        onRestore={onRestore} onPurge={() => undefined} />,
    )
    const btn = screen.getByRole('button', { name: 'Вернуть' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRestore).not.toHaveBeenCalled()
  })
})
