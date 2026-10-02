import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Asset, AssetUsage } from '../../api/assets'
import type { TransferFrame } from '../../lib/assetTransfer'

import { ProjectFiles, moveTargets, usageLabel, usageShare } from './ProjectFiles'

/**
 * Список файлов проекта: расход места, удаление, загрузка нескольких файлов и перенос
 * вложения между кадрами.
 *
 * Проверяем то, что человек видит и нажимает: где файл лежит сейчас, куда его можно
 * перенести, что нельзя удалить прикреплённый файл и что отказ сервера показан его же
 * словами.
 */
function asset(partial: Partial<Asset>): Asset {
  return {
    id: 'a1',
    project_id: 'p1',
    owner_id: 'u1',
    filename: 'файл.png',
    mime: 'image/png',
    size: 1024,
    s3_key: 'k',
    kind: 'image',
    created_at: '2026-10-02T00:00:00Z',
    ...partial,
  }
}

const usage: AssetUsage = {
  used: 4 * 1024 * 1024,
  limit: 10 * 1024 * 1024,
  used_text: '4.0 МБ',
  limit_text: '10.0 МБ',
}

const chapter: TransferFrame = {
  id: 'c1',
  label: '01 Пролог',
  assetIds: ['a1'],
  backgroundAssetId: 'a1',
}
const sub: TransferFrame = {
  id: 's1',
  label: '01.1 Рассвет',
  assetIds: [],
  backgroundAssetId: null,
}

/** Минимальные пропсы: остальное в тестах не участвует. */
function renderFiles(props: Partial<Parameters<typeof ProjectFiles>[0]> = {}) {
  const onDelete = vi.fn()
  const onMove = vi.fn()
  const onUploadFiles = vi.fn()
  const view = render(
    <ProjectFiles
      assets={[asset({})]}
      usage={usage}
      attached={new Set()}
      frames={[chapter, sub]}
      onDelete={onDelete}
      onMove={onMove}
      onUploadFiles={onUploadFiles}
      {...props}
    />,
  )
  return { view, onDelete, onMove, onUploadFiles }
}

describe('usageLabel', () => {
  it('с пределом показывает и занятое, и предел', () => {
    expect(usageLabel(usage, [])).toBe('4.0 МБ из 10.0 МБ')
  })

  it('без предела показывает только вес', () => {
    expect(usageLabel({ ...usage, limit: 0 }, [])).toBe('4.0 МБ — без предела')
  })

  it('без ответа сервера считает вес по списку файлов', () => {
    expect(usageLabel(null, [asset({ size: 1024 }), asset({ id: 'a2', size: 2048 })])).toBe('3 КБ')
  })
})

describe('usageShare', () => {
  it('доля занятого места', () => {
    expect(usageShare(usage)).toBeCloseTo(0.4)
  })

  it('без предела или без расхода — ноль, а не деление на ноль', () => {
    expect(usageShare(null)).toBe(0)
    expect(usageShare({ ...usage, limit: 0 })).toBe(0)
  })
})

describe('moveTargets', () => {
  it('предлагает только те кадры, где файла ещё нет', () => {
    expect(moveTargets([chapter, sub], 'a1').map((f) => f.label)).toEqual(['01.1 Рассвет'])
    expect(moveTargets([chapter, sub], 'a9').map((f) => f.label)).toEqual([
      '01 Пролог',
      '01.1 Рассвет',
    ])
  })
})

describe('ProjectFiles', () => {
  it('показывает файлы, вес, расход места и где файл лежит', () => {
    // Кадров, в которых файл был бы прикреплён, нет — так и должно быть написано.
    renderFiles({
      assets: [asset({ filename: 'карта.png', size: 2 * 1024 * 1024 })],
      frames: [{ ...chapter, assetIds: [] }, sub],
    })
    expect(screen.getByText('Файлы проекта (1)')).toBeTruthy()
    expect(screen.getByText('4.0 МБ из 10.0 МБ')).toBeTruthy()
    expect(screen.getByText('карта.png')).toBeTruthy()
    expect(screen.getByText('2.0 МБ')).toBeTruthy()
    // Файл ни к чему не прикреплён — так и написано, а не пустое место.
    expect(screen.getByText('ни в одном кадре')).toBeTruthy()
  })

  it('удаляет свободный файл', () => {
    const { onDelete } = renderFiles({ assets: [asset({ id: 'a1' })] })
    fireEvent.click(screen.getByLabelText('Удалить файл.png'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('прикреплённый файл удалить нельзя, и объяснено почему', () => {
    const { onDelete } = renderFiles({ assets: [asset({ id: 'a1' })], attached: new Set(['a1']) })
    const button = screen.getByLabelText('Удалить файл.png') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('сначала открепите')
    fireEvent.click(button)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('показывает отказ сервера как есть', () => {
    renderFiles({
      assets: [asset({})],
      attached: new Set(['a1']),
      note: 'файл прикреплён к 2 кадрам — сначала открепите его',
    })
    expect(screen.getByRole('status').textContent).toContain('прикреплён к 2 кадрам')
  })

  it('близко к пределу — предупреждает заранее', () => {
    renderFiles({ usage: { ...usage, used: 9 * 1024 * 1024, used_text: '9.0 МБ' } })
    expect(screen.getByText(/место заканчивается/)).toBeTruthy()
  })

  it('загружает несколько файлов сразу и ни к чему их не привязывает', () => {
    const { onUploadFiles } = renderFiles()
    const input = document.querySelector('.ed-files__upload input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const one = new File(['a'], 'a.png', { type: 'image/png' })
    const two = new File(['b'], 'b.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [one, two] } })
    expect(onUploadFiles).toHaveBeenCalledTimes(1)
    expect(onUploadFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.png', 'b.png'])
  })

  it('переносит файл в выбранный кадр и показывает, где он лежит сейчас', () => {
    const { onMove } = renderFiles({ assets: [asset({ id: 'a1' })], attached: new Set(['a1']) })
    expect(screen.getByText('01 Пролог')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'перенести' }))
    fireEvent.change(screen.getByLabelText('Кадр для файл.png'), { target: { value: 's1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Перенести' }))

    // «Откуда» — кадр, где файл лежит; «куда» — выбранный.
    expect(onMove).toHaveBeenCalledWith('a1', 'c1', 's1')
  })

  it('свободный файл можно прикрепить к кадру той же кнопкой', () => {
    const { onMove } = renderFiles({
      assets: [asset({ id: 'a1' })],
      attached: new Set(),
      // Файла нет ни в одном кадре: кнопка предлагает «прикрепить».
      frames: [{ ...chapter, assetIds: [] }, sub],
    })
    fireEvent.click(screen.getByRole('button', { name: 'прикрепить' }))
    fireEvent.change(screen.getByLabelText('Кадр для файл.png'), { target: { value: 'c1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Прикрепить' }))
    expect(onMove).toHaveBeenCalledWith('a1', null, 'c1')
  })

  it('без свободных кадров кнопка переноса выключена и объясняет почему', () => {
    // Файл уже во всех кадрах проекта: переносить некуда.
    const frames = [
      { ...chapter, assetIds: ['a1'] },
      { ...sub, assetIds: ['a1'] },
    ]
    renderFiles({ assets: [asset({ id: 'a1' })], attached: new Set(['a1']), frames })
    const button = screen.getByRole('button', { name: 'перенести' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('некуда переносить')
  })
})
