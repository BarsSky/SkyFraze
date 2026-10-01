import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Asset, AssetUsage } from '../../api/assets'

import { ProjectFiles, usageLabel, usageShare } from './ProjectFiles'

/**
 * Список файлов проекта появился вместе с квотой: до него место в проекте нельзя
 * было освободить из интерфейса. Проверяем то, что человек видит и нажимает:
 * расход места, запрет на удаление прикреплённого файла и текст отказа сервера.
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

const usage: AssetUsage = { used: 4 * 1024 * 1024, limit: 10 * 1024 * 1024, used_text: '4.0 МБ', limit_text: '10.0 МБ' }

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

describe('ProjectFiles', () => {
  it('показывает файлы, вес и расход места', () => {
    render(
      <ProjectFiles
        assets={[asset({ filename: 'карта.png', size: 2 * 1024 * 1024 })]}
        usage={usage}
        attached={new Set()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('Файлы проекта (1)')).toBeTruthy()
    expect(screen.getByText('4.0 МБ из 10.0 МБ')).toBeTruthy()
    expect(screen.getByText('карта.png')).toBeTruthy()
    expect(screen.getByText('2.0 МБ')).toBeTruthy()
  })

  it('удаляет свободный файл', () => {
    const onDelete = vi.fn()
    render(<ProjectFiles assets={[asset({ id: 'a1' })]} usage={usage} attached={new Set()} onDelete={onDelete} />)
    fireEvent.click(screen.getByLabelText('Удалить файл.png'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('прикреплённый файл удалить нельзя, и объяснено почему', () => {
    const onDelete = vi.fn()
    render(
      <ProjectFiles assets={[asset({ id: 'a1' })]} usage={usage} attached={new Set(['a1'])} onDelete={onDelete} />,
    )
    const button = screen.getByLabelText('Удалить файл.png') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('сначала открепите')
    fireEvent.click(button)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('показывает отказ сервера как есть', () => {
    render(
      <ProjectFiles
        assets={[asset({})]}
        usage={usage}
        attached={new Set(['a1'])}
        note="файл прикреплён к 2 кадрам — сначала открепите его"
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('прикреплён к 2 кадрам')
  })

  it('близко к пределу — предупреждает заранее', () => {
    render(
      <ProjectFiles
        assets={[asset({})]}
        usage={{ ...usage, used: 9 * 1024 * 1024, used_text: '9.0 МБ' }}
        attached={new Set()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText(/место заканчивается/)).toBeTruthy()
  })
})
