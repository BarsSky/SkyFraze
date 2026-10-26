import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TrashPanel } from './TrashPanel'
import type { TrashedProject } from '../../api/projects'

/**
 * Корзина проектов.
 *
 * Проверяем обещание, а не разметку: «вернуть можно ещё N дней» обязано быть на экране,
 * «навсегда» — отдельной кнопкой, архив скачивается не возвращая проект, а пустая корзина
 * должна говорить, что она пуста, а не выглядеть сломанной.
 */

const project = (over: Partial<TrashedProject> = {}): TrashedProject => ({
  id: 'p1',
  title: 'Рукопись',
  description: '',
  deleted_at: '2026-10-01T10:00:00Z',
  days_left: 30,
  ...over,
})

const noop = () => undefined

afterEach(cleanup)

describe('TrashPanel', () => {
  it('показывает срок хранения и остаток дней', () => {
    render(
      <TrashPanel items={[project({ days_left: 30 })]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.getByText('Корзина')).toBeTruthy()
    // Срок — обещание: он написан и в шапке, и у самого проекта.
    expect(screen.getByText(/Удалённое хранится 30 дней/)).toBeTruthy()
    expect(screen.getByText(/вернуть можно ещё 30 дней/)).toBeTruthy()
  })

  it('склоняет остаток и не обещает возврат после срока', () => {
    const { rerender } = render(
      <TrashPanel items={[project({ days_left: 1 })]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.getByText(/вернуть можно ещё 1 день/)).toBeTruthy()

    rerender(
      <TrashPanel items={[project({ days_left: 0 })]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.getByText(/срок восстановления истёк/)).toBeTruthy()
  })

  it('показывает вес файлов: файлы в корзине не удалены', () => {
    render(
      <TrashPanel items={[project({ asset_bytes: 2048 })]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.getByText(/файлы: 2 КБ/)).toBeTruthy()
  })

  it('без файлов вес не выдумывает', () => {
    render(
      <TrashPanel items={[project({ asset_bytes: 0 })]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.queryByText(/файлы:/)).toBeNull()
  })

  it('возврат, архив и окончательное удаление — разные кнопки', () => {
    const onRestore = vi.fn()
    const onPurge = vi.fn()
    const onExport = vi.fn()
    render(
      <TrashPanel items={[project()]} retentionDays={30} busyId={null}
        onRestore={onRestore} onPurge={onPurge} onExport={onExport} />,
    )
    // Ошибка в этом месте необратима: «удалить навсегда» не должно быть тем же
    // нажатием, что «вернуть» или «скачать».
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }))
    fireEvent.click(screen.getByRole('button', { name: 'Скачать архив' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить навсегда' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onExport).toHaveBeenCalledTimes(1)
    expect(onPurge).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0][0].id).toBe('p1')
    expect(onExport.mock.calls[0][0].id).toBe('p1')
    expect(onPurge.mock.calls[0][0].id).toBe('p1')
  })

  it('пустая корзина говорит об этом и не рисует кнопок', () => {
    render(
      <TrashPanel items={[]} retentionDays={30} busyId={null}
        onRestore={noop} onPurge={noop} onExport={noop} />,
    )
    expect(screen.getByText(/Пусто\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Вернуть' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Скачать архив' })).toBeNull()
  })

  it('во время запроса кнопки не нажимаются повторно', () => {
    const onRestore = vi.fn()
    const onExport = vi.fn()
    render(
      <TrashPanel items={[project()]} retentionDays={30} busyId="p1"
        onRestore={onRestore} onPurge={noop} onExport={onExport} />,
    )
    const restore = screen.getByRole('button', { name: 'Вернуть' }) as HTMLButtonElement
    const archive = screen.getByRole('button', { name: 'Скачать архив' }) as HTMLButtonElement
    expect(restore.disabled).toBe(true)
    expect(archive.disabled).toBe(true)
    fireEvent.click(restore)
    fireEvent.click(archive)
    expect(onRestore).not.toHaveBeenCalled()
    expect(onExport).not.toHaveBeenCalled()
  })
})
