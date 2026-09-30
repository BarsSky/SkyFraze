import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { colorFor, initialsOf, type PeerState } from '../../collab/awareness'
import { PresenceBar } from './PresenceBar'

/**
 * Витрина присутствия: кто в проекте, что правит и кто печатает.
 *
 * Проверяем ровно то, на что смотрит человек и на что опирается живая проверка в
 * двух браузерах: контракт `data-presence*`, молчание при пустом списке и то, что
 * подпись «печатает…» не размножается по соседям одного события.
 */

/** Сосед в том виде, в каком его отдаёт `collab.presence`. */
const peer = (over: Partial<PeerState> = {}): PeerState => {
  const merged = {
    clientId: 'c1',
    userId: 'u1',
    name: 'Аня Ваар',
    eventId: null as string | null,
    typing: false,
    ...over,
  }
  return { ...merged, initials: initialsOf(merged.name), color: colorFor(merged.userId) }
}

/** jsdom нормализует `hsl(...)` в `rgb(...)`: сравниваем обе строки в одном виде. */
const asRgb = (color: string): string => {
  const probe = document.createElement('span')
  probe.style.backgroundColor = color
  return probe.style.backgroundColor
}

const peersOf = () => Array.from(document.querySelectorAll<HTMLElement>('[data-presence-peer]'))

afterEach(() => cleanup())

describe('PresenceBar — кто в проекте', () => {
  it('в пустом проекте не рендерит ничего', () => {
    const { container } = render(<PresenceBar peers={[]} events={[{ id: 'e1', title: 'Глава 1' }]} />)

    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('[data-presence]')).toBeNull()
  })

  it('печатающий сосед показан с именем и подписью «печатает…»', () => {
    const { container } = render(
      <PresenceBar
        peers={[peer({ typing: true, eventId: 'e1' })]}
        events={[{ id: 'e1', title: 'Глава 1' }]}
      />,
    )

    expect(screen.getByText('Аня Ваар')).toBeInTheDocument()
    expect(container.querySelector('[data-presence-typing]')?.textContent)
      .toContain('Аня Ваар печатает…')
    // Где правит: название события из переданного списка.
    expect(screen.getByText('правит «Глава 1»')).toBeInTheDocument()
    expect(peersOf()).toHaveLength(1)
    expect(peersOf()[0].dataset.peerName).toBe('Аня Ваар')
  })

  it('двое соседей — два участника списка', () => {
    render(
      <PresenceBar
        peers={[peer({ clientId: 'c1', userId: 'u1', name: 'Аня Ваар' }), peer({ clientId: 'c2', userId: 'u2', name: 'Борис Ким' })]}
        events={[]}
      />,
    )

    expect(peersOf().map((el) => el.dataset.peerName)).toEqual(['Аня Ваар', 'Борис Ким'])
    expect(screen.getByText('Аня Ваар')).toBeInTheDocument()
    expect(screen.getByText('Борис Ким')).toBeInTheDocument()
  })

  it('цвет аватарки берётся из peer.color', () => {
    const anya = peer({ userId: 'u1' })
    const { container } = render(<PresenceBar peers={[anya]} events={[]} />)

    const avatar = container.querySelector<HTMLElement>('.presence__avatar')
    expect(avatar?.style.backgroundColor).toBe(asRgb(anya.color))
    expect(avatar?.textContent).toBe('АВ')
  })

  it('двое печатающих на одном событии дают одну подпись на всех', () => {
    const { container } = render(
      <PresenceBar
        peers={[
          peer({ clientId: 'c1', userId: 'u1', name: 'Аня Ваар', typing: true, eventId: 'e1' }),
          peer({ clientId: 'c2', userId: 'u2', name: 'Борис Ким', typing: true, eventId: 'e1' }),
        ]}
        events={[{ id: 'e1', title: 'Глава 1' }]}
      />,
    )

    const indicators = container.querySelectorAll('[data-presence-typing]')
    expect(indicators).toHaveLength(1)
    expect(indicators[0].textContent).toContain('Аня Ваар и Борис Ким печатают…')
  })

  it('событие вне списка подписано «правит другое событие»', () => {
    render(<PresenceBar peers={[peer({ eventId: 'e9' })]} events={[{ id: 'e1', title: 'Глава 1' }]} />)

    expect(screen.getByText('правит другое событие')).toBeInTheDocument()
    expect(screen.queryByText('правит «Глава 1»')).toBeNull()
  })
})
