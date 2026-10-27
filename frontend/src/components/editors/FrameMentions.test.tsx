import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FrameMentions } from './FrameMentions'
import type { Mention } from '../../collab/mentions'

/**
 * «Упоминания в кадре»: кто из карточек мира назван в этом кадре.
 *
 * Главное, что проверяется: чип показывает ИМЯ и ЦИТАТУ (по цитате человек понимает, то ли это
 * слово), клик отдаёт диапазон и поле — чтобы панель выделила место в правильном поле, — а если
 * упоминаний нет, блок не занимает место вовсе.
 */

const mention = (over: Partial<Mention> = {}): Mention => ({
  entityId: 'e1',
  entityName: 'Анна',
  field: 'body',
  from: 10,
  to: 14,
  quote: 'Анны',
  ...over,
})

afterEach(() => cleanup())

describe('FrameMentions', () => {
  it('без упоминаний блок не рисуется: пустой строки «Упоминания:» не должно быть', () => {
    const { container } = render(<FrameMentions mentions={[]} onShow={() => {}} />)
    expect(container.textContent).toBe('')
  })

  it('показывает имя, цитату и отдаёт диапазон по клику', () => {
    const onShow = vi.fn()
    render(
      <FrameMentions
        mentions={[mention(), mention({ entityId: 'e2', entityName: 'Дом на холме', quote: 'дом на холме' })]}
        onShow={onShow}
      />,
    )
    expect(screen.getByText('Анна')).toBeTruthy()
    expect(screen.getByText('Анны')).toBeTruthy()
    expect(screen.getByText('Дом на холме')).toBeTruthy()

    fireEvent.click(screen.getByText('Анна'))
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ from: 10, to: 14, field: 'body' }))
  })

  it('заголовок и текст различимы: поле уходит в вызов, а не теряется', () => {
    const onShow = vi.fn()
    render(
      <FrameMentions
        mentions={[mention({ field: 'title', from: 0, to: 4, quote: 'Анна' })]}
        onShow={onShow}
      />,
    )
    // Имя и цитата совпадают («Анна» в заголовке), поэтому жмём кнопку, а не текст.
    fireEvent.click(screen.getByRole('button'))
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ field: 'title', from: 0, to: 4 }))
  })

  it('цитата показывается только когда отличается от имени по буквам', () => {
    render(
      <FrameMentions
        mentions={[
          // Совпадает по буквам — подпись «Анна Анна» была бы шумом.
          mention({ field: 'title', from: 0, to: 4, quote: 'Анна' }),
          mention({ from: 10, to: 14, quote: 'Анны' }),
        ]}
        onShow={() => {}}
      />,
    )
    const chips = screen.getAllByRole('button')
    expect(chips[0].textContent).toBe('Анна')
    expect(chips[1].textContent).toBe('АннаАнны')
  })

  it('две карточки в одном кадре — две кнопки, а не одна слитая', () => {
    render(
      <FrameMentions
        mentions={[mention(), mention({ entityId: 'e2', entityName: 'Письмо', quote: 'Письмо' })]}
        onShow={() => {}}
      />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
