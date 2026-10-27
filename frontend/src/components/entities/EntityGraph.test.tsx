import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EntityGraph } from './EntityGraph'


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

  it('клик по соседу делает его центром, «назад» возвращает', async () => {
    render(<EntityGraph entities={[anna, earth]} links={[link]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Земля' }))
    // Теперь центр — Земля, а её сосед — Аня (обратная сторона связи).
    expect(await screen.findByText('← живёт на')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'назад' }))
    expect(await screen.findByText('→ живёт на')).toBeTruthy()
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
})
