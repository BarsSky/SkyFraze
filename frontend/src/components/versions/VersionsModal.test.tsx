import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../api/versions', () => ({
  listProjectVersions: mocks.list,
  saveProjectVersion: mocks.save,
  getProjectVersion: mocks.get,
  restoreProjectVersion: mocks.restore,
  deleteProjectVersion: mocks.remove,
}))

vi.mock('../../api/client', () => ({ serverErrorMessage: mocks.error }))

import { VersionsModal } from './VersionsModal'

const VERSION = {
  id: 'v1',
  kind: 'manual',
  label: 'перед переписыванием',
  events: 3,
  size: 2048,
  createdAt: '2026-10-24T10:15:00Z',
  createdBy: 'u1',
}

function renderModal(props: Partial<Parameters<typeof VersionsModal>[0]> = {}) {
  const all = {
    projectId: 'p1',
    canEdit: true,
    onClose: () => {},
    onRestored: () => {},
    ...props,
  }
  return render(<VersionsModal {...all} />)
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.list.mockResolvedValue([VERSION])
  mocks.error.mockResolvedValue(null)
})

afterEach(() => cleanup())

describe('VersionsModal', () => {
  it('показывает версии и подписывает их вид и объём', async () => {
    renderModal()
    expect(await screen.findByText(/Вручную · перед переписыванием/)).toBeTruthy()
    // Число кадров и объём — одной строкой под подписью.\n    expect(screen.getByText(/кадр/)).toBeTruthy()
    expect(screen.getByText(/2 КБ/)).toBeTruthy()
  })

  it('восстановление спрашивает подтверждение, а не меняет проект сразу', async () => {
    const onRestored = vi.fn()
    mocks.restore.mockResolvedValue({ removed: 0, added: 1, updated: 2, moved: 0, warning: '' })
    renderModal({ onRestored })

    fireEvent.click(await screen.findByRole('button', { name: 'Восстановить' }))
    // Первое нажатие только спрашивает: проект ещё не тронут.
    expect(mocks.restore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Точно восстановить?' }))

    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith('p1', 'v1'))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    expect(await screen.findByText(/переписано 2/)).toBeTruthy()
  })

  it('показывает, что было в версии, до восстановления', async () => {
    mocks.get.mockResolvedValue({
      version: VERSION,
      frames: [{ id: 'e1', depth: 0, title: 'Глава 1', date: '', chars: 12 }],
      chars: 12,
    })
    renderModal()

    fireEvent.click(await screen.findByRole('button', { name: 'Показать' }))
    expect(await screen.findByText(/В версии/)).toBeTruthy()
    expect(screen.getByText(/Глава 1/)).toBeTruthy()
    // «12 знаков» есть и в сводке версии, и в строке кадра — это нормально.\n    expect(screen.getAllByText(/12 знаков/).length).toBeGreaterThan(0)
  })

  it('читателю не показывает ни сохранения, ни восстановления', async () => {
    renderModal({ canEdit: false })
    expect(await screen.findByText(/Вручную/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Сохранить версию' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Восстановить' })).toBeNull()
  })

  it('спасает версию по кнопке и перечитывает список', async () => {
    mocks.save.mockResolvedValue(VERSION)
    renderModal()

    fireEvent.change(await screen.findByLabelText('Подпись версии'), {
      target: { value: 'черновик' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить версию' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('p1', 'черновик'))
    expect(await screen.findByText(/Версия сохранена/)).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })
})
