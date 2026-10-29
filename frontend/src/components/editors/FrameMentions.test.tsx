import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FrameMentions, MENTIONS_VISIBLE } from './FrameMentions'
import { setLang } from '../../store/lang'
import { groupMentions, type Mention } from '../../collab/mentions'

/**
 * «Упоминания в кадре»: кто из карточек мира назван в этом кадре.
 *
 * Главное, что проверяется: чип показывает ИМЯ и ЦИТАТУ (по цитате человек понимает, то ли это
 * слово), клик отдаёт диапазон и поле — чтобы панель выделила место в правильном поле, — а если
 * упоминаний нет, блок не занимает место вовсе.
 *
 * 0.92.1 — чип ОДИН на карточку: вхождений в кадре может быть шесть, а карточка одна. Отчёт был
 * именно об этом: список дублировался и распухал.
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

describe('groupMentions', () => {
  it('одна карточка — одна группа, порядок вхождений сохранён', () => {
    const groups = groupMentions([
      mention({ field: 'title', from: 0, to: 4, quote: 'Анна' }),
      mention({ entityId: 'e2', entityName: 'Дом', from: 20, to: 23, quote: 'Дом' }),
      mention({ from: 30, to: 35, quote: 'Анны' }),
    ])
    expect(groups.map((group) => group.entityId)).toEqual(['e1', 'e2'])
    expect(groups[0].mentions.map((item) => item.from)).toEqual([0, 30])
  })

  it('порядок — по первому появлению, а не по частоте', () => {
    const groups = groupMentions([
      mention({ entityId: 'a', entityName: 'Ио' }),
      mention({ entityId: 'b', entityName: 'Европа' }),
      mention({ entityId: 'a', entityName: 'Ио' }),
      mention({ entityId: 'c', entityName: 'Ганимед' }),
    ])
    expect(groups.map((group) => group.entityName)).toEqual(['Ио', 'Европа', 'Ганимед'])
    expect(groups[0].mentions).toHaveLength(2)
  })
})

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
    render(<FrameMentions mentions={[mention({ quote: 'Анна' })]} onShow={() => {}} />)
    expect(screen.getByRole('button').textContent).toBe('Анна')
    cleanup()
    render(<FrameMentions mentions={[mention({ quote: 'Анны' })]} onShow={() => {}} />)
    expect(screen.getByRole('button').textContent).toBe('АннаАнны')
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

  it('шесть вхождений одной карточки — ОДИН чип со счётчиком, а не шесть (0.92.1)', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      mention({
        entityName: 'Ганимед',
        from: index * 10,
        to: index * 10 + 8,
        quote: 'Ганимед',
      }),
    )
    render(<FrameMentions mentions={many} onShow={() => {}} />)
    const chips = screen.getAllByRole('button')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe('Ганимед×6')
    expect(chips[0].getAttribute('data-frame-mention-count')).toBe('6')
  })

  it('повторное нажатие ведёт к СЛЕДУЮЩЕМУ вхождению, а не к тому же месту', () => {
    const onShow = vi.fn()
    render(
      <FrameMentions
        mentions={[
          mention({ field: 'title', from: 0, to: 4, quote: 'Анна' }),
          mention({ from: 30, to: 34, quote: 'Анны' }),
          mention({ from: 60, to: 64, quote: 'Анне' }),
        ]}
        onShow={onShow}
      />,
    )
    const chip = screen.getByRole('button')
    fireEvent.click(chip)
    fireEvent.click(chip)
    fireEvent.click(chip)
    expect(onShow.mock.calls.map((call) => call[0].from)).toEqual([0, 30, 60])
    // После последнего вхождения — снова первое: круг замкнут, ни одно место не потерялось.
    fireEvent.click(chip)
    expect(onShow.mock.calls[3][0].from).toBe(0)
  })

  it('длинный список сворачивается в «ещё N» и раскрывается кнопкой', () => {
    const many = Array.from({ length: MENTIONS_VISIBLE + 4 }, (_, index) =>
      mention({ entityId: `e${index}`, entityName: `Карточка ${index}`, quote: `Карточка ${index}` }),
    )
    render(<FrameMentions mentions={many} onShow={() => {}} />)
    // Видим ровно лимит + кнопку «ещё».
    expect(screen.getAllByRole('button')).toHaveLength(MENTIONS_VISIBLE + 1)
    const more = screen.getByRole('button', { name: /ещё 4/ })
    fireEvent.click(more)
    expect(screen.getAllByRole('button')).toHaveLength(MENTIONS_VISIBLE + 5)
    expect(screen.queryByRole('button', { name: /ещё/ })).toBeNull()
    // Свернуть обратно — тоже кнопка, а не только повторное нажатие туда же.
    fireEvent.click(screen.getByRole('button', { name: 'свернуть' }))
    expect(screen.getAllByRole('button')).toHaveLength(MENTIONS_VISIBLE + 1)
  })

  it('короткий список кнопки «ещё» не получает', () => {
    render(
      <FrameMentions
        mentions={[mention(), mention({ entityId: 'e2', entityName: 'Письмо', quote: 'Письмо' })]}
        onShow={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /ещё/ })).toBeNull()
  })
})

it('кадр без упоминаний: подсказка про алиасы вместо молчания (0.72.1)', () => {
  render(<FrameMentions mentions={[]} onShow={() => {}} hasEntities />)
  expect(screen.getByText(/не названо ни одной карточки/)).toBeTruthy()
  expect(screen.getByText(/алиасы/)).toBeTruthy()
})

it('без карточек подсказки нет: подсказывать нечего', () => {
  const { container } = render(<FrameMentions mentions={[]} onShow={() => {}} />)
  expect(container.textContent).toBe('')
})

/**
 * 0.123.0: подписи блока — из словаря. Имя карточки и цитата остаются данными, поэтому
 * в подсказке чипа переводится только обвязка («Show in the text: … — each press …»).
 */
it('на английском подпись блока и подсказки переведены', () => {
  setLang('en')
  const two = [
    mention({ entityId: 'e1', entityName: 'Анна', quote: 'Анну' }),
    mention({ entityId: 'e1', entityName: 'Анна', quote: 'Анна' }),
  ]
  render(<FrameMentions mentions={two} onShow={() => {}} />)
  expect(screen.getByText('Mentions:')).toBeTruthy()
  const chip = screen.getAllByRole('button')[0]
  expect(chip.getAttribute('aria-label')).toBe('Анна, mentions: 2')
  expect(chip.getAttribute('title')).toContain('Show in the text:')
  expect(chip.getAttribute('title')).toContain('each press goes to the next one')

  cleanup()
  setLang('en')
  render(<FrameMentions mentions={[]} onShow={() => {}} hasEntities />)
  expect(screen.getByText(/add it to the card aliases/)).toBeTruthy()
})
