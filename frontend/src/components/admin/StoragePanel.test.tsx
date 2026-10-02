import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecompressReport, StorageReport } from '../../api/admin'

import { StoragePanel } from './StoragePanel'

/**
 * Экран хранилища.
 *
 * До него отчёт, уборка и пережатие жили только в curl — то есть на практике никто
 * не смотрел, кончается ли место. Проверяем то, ради чего экран существует: числа
 * видны, расхождения каталога с базой объяснены, уборка спрашивает подтверждение, а
 * пережатие сначала считает и только потом (по отдельной кнопке) применяет —
 * оригиналы картинок не хранятся, и «применить» не должно происходить случайно.
 */
const report = (partial: Partial<StorageReport> = {}): StorageReport => ({
  scanned_at: '2026-10-01T10:00:00Z',
  scan_ms: 12,
  database_bytes: 10 * 1024 * 1024,
  tables: [
    { name: 'project_event_state', bytes: 800 * 1024 },
    { name: 'events', bytes: 300 * 1024 },
  ],
  projects: 12,
  snapshot_count: 10,
  snapshot_bytes: 728242,
  projects_usage: [
    // Публичный проект: название видно и так, в ленте.
    {
      id: 'p1',
      title: 'Планета — АнуВаар',
      is_public: true,
      owner_email: 'author@example.com',
      asset_bytes: 5481636,
      snapshot_bytes: 16209,
    },
    // Приватный: названия нет вовсе — сервер его не присылает, видно владельца.
    { id: 'p2', is_public: false, owner_email: 'owner@example.com', asset_bytes: 0, snapshot_bytes: 711378 },
  ],
  event_rows: 340,
  event_text_bytes: 210 * 1024,
  asset_rows: 4,
  asset_bytes: 5481636,
  file_count: 8,
  file_bytes: 6768032,
  orphan_files: 4,
  orphan_bytes: 1286396,
  pending_files: 0,
  missing_files: 0,
  removed_files: 0,
  removed_bytes: 0,
  failed_files: 0,
  ...partial,
})

const recompressReport = (partial: Partial<RecompressReport> = {}): RecompressReport => ({
  files: 4,
  images: 4,
  changed: 4,
  skipped: 0,
  damaged: 0,
  failed: 0,
  bytes_from: 7667703,
  bytes_to: 5481636,
  applied: false,
  ...partial,
})

const calls = {
  report: vi.fn(),
  sweep: vi.fn(),
  recompress: vi.fn(),
}

vi.mock('../../api/admin', () => ({
  getStorageReport: () => calls.report(),
  sweepStorage: () => calls.sweep(),
  recompressStorage: (apply = false) => calls.recompress(apply),
}))

beforeEach(() => {
  calls.report.mockReset().mockResolvedValue(report())
  calls.sweep.mockReset()
  calls.recompress.mockReset()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('StoragePanel', () => {
  it('показывает размеры базы, снапшотов, вложений и каталога', async () => {
    render(<StoragePanel />)
    await waitFor(() => expect(screen.getByText('Хранилище')).toBeTruthy())
    expect(await screen.findByText('10.0 МБ')).toBeTruthy() // база
    expect(screen.getByText('711 КБ')).toBeTruthy() // снапшоты
    expect(screen.getByText('5.2 МБ')).toBeTruthy() // вложения
    expect(screen.getByText('6.5 МБ')).toBeTruthy() // файлы на диске
    expect(screen.getByText('12')).toBeTruthy() // проектов
    expect(screen.getByText(/обход каталога: 12 мс/)).toBeTruthy()
  })

  it('показывает вес проектов, но названия — только у публичных', async () => {
    calls.report.mockResolvedValue(
      report({ pending_files: 2, missing_files: 1, missing_examples: [{ key: 'proj/карта.png' }] }),
    )
    render(<StoragePanel />)
    // Текст разметки разбит на элементы (число — отдельным <b>), поэтому читаем
    // содержимое блока целиком: так проверка не зависит от вёрстки.
    await waitFor(() =>
      expect(document.querySelector('.admin__storage-diff')?.textContent).toMatch(/4\s*файлов без строк в базе/),
    )
    const diff = document.querySelector('.admin__storage-diff')?.textContent ?? ''
    expect(diff).toMatch(/свежих файлов без строк/)
    expect(diff).toMatch(/строк без файла/)
    // Строка без файла — это содержимое проекта: показываем хотя бы один ключ,
    // иначе по числу непонятно, где искать.
    expect(diff).toMatch(/proj\/карта\.png/)

    // Публичный проект — по названию (оно и так видно в ленте), приватный — по
    // владельцу: название приватного проекта админу не показываем.
    const table = document.querySelector('.admin__storage-more')?.textContent ?? ''
    expect(table).toMatch(/Планета — АнуВаар/)
    expect(table).toMatch(/публичный/)
    expect(table).toMatch(/приватный проект/)
    expect(table).toMatch(/owner@example\.com/)
    // Вес по частям: вложения и история правок — разными числами.
    expect(table).toMatch(/файлы 5\.2 МБ · история 16 КБ · всего 5\.2 МБ/)
    expect(screen.getByText(/Название приватного проекта — тоже содержимое/)).toBeTruthy()
  })

  it('уборка спрашивает подтверждение и показывает, что убрала', async () => {
    calls.sweep.mockResolvedValue(report({ orphan_files: 4, removed_files: 4, removed_bytes: 1286396 }))
    render(<StoragePanel />)
    await waitFor(() => expect(document.querySelector('.admin__storage-diff')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Убрать лишние файлы' }))
    await waitFor(() => expect(calls.sweep).toHaveBeenCalledTimes(1))
    expect(window.confirm).toHaveBeenCalled()
    expect(await screen.findByText(/Убрано 4 файлов на 1.2 МБ/)).toBeTruthy()
  })

  it('пережатие: сначала считает, применяет только второй кнопкой', async () => {
    calls.recompress.mockResolvedValue(recompressReport())
    render(<StoragePanel />)
    await screen.findByText('Хранилище')

    fireEvent.click(screen.getByRole('button', { name: 'Пережать картинки: посчитать' }))
    await waitFor(() => expect(calls.recompress).toHaveBeenCalledWith(false))
    // Сухой прогон: применение ещё не запускалось, ничего не перезаписано.
    expect(calls.recompress).not.toHaveBeenCalledWith(true)
    expect(await screen.findByText(/Можно сэкономить 2.1 МБ на 4 файлах/)).toBeTruthy()
    expect(screen.getByText(/не разобралось: 0/)).toBeTruthy()

    calls.recompress.mockResolvedValue(recompressReport({ applied: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Пережать 4 файлов' }))
    await waitFor(() => expect(calls.recompress).toHaveBeenCalledWith(true))
    expect(window.confirm).toHaveBeenCalled()
    expect(await screen.findByText(/Пережато 4 файлов: 7.3 МБ → 5.2 МБ/)).toBeTruthy()
  })

  it('когда пережимать нечего — говорит об этом, а не зовёт применять', async () => {
    calls.recompress.mockResolvedValue(recompressReport({ changed: 0, bytes_from: 0, bytes_to: 0 }))
    render(<StoragePanel />)
    await screen.findByText('Хранилище')
    fireEvent.click(screen.getByRole('button', { name: 'Пережать картинки: посчитать' }))
    expect(await screen.findByText('Пережимать нечего')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Пережать \d/ })).toBeNull()
  })

  it('ошибка отчёта показывается текстом сервера', async () => {
    calls.report.mockRejectedValue({
      response: new Response(JSON.stringify({ error: 'storage report failed' }), { status: 500 }),
    })
    render(<StoragePanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('storage report failed')
  })
})
