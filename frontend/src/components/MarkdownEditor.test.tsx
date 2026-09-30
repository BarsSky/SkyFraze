import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MarkdownEditor } from './MarkdownEditor'

/**
 * Живое окно Markdown: пока оно открыто, чужие правки не должны теряться.
 * Правило решения проверяется отдельно (`collab/liveText.test.ts`) — здесь
 * проверяем исполнение в компоненте, то есть что человек реально видит.
 *
 * `@testing-library/user-event` в проекте не установлен (другие tsx-тесты
 * используют `fireEvent`), поэтому ввод эмулируем им же.
 */
function setup(value: string) {
  const onSave = vi.fn()
  const onAdopt = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <MarkdownEditor value={value} onSave={onSave} onAdopt={onAdopt} onClose={onClose} title="Глава" />,
  )
  const textarea = () => screen.getByLabelText('Текст события в Markdown') as HTMLTextAreaElement
  /** Набрать текст «как пользователь»: в конец текущего значения. */
  const type = (suffix: string) => {
    fireEvent.change(textarea(), { target: { value: textarea().value + suffix } })
  }
  const rerender = (next: string) => view.rerender(
    <MarkdownEditor value={next} onSave={onSave} onAdopt={onAdopt} onClose={onClose} title="Глава" />,
  )
  return { onSave, onAdopt, onClose, view, textarea, type, rerender }
}

describe('MarkdownEditor — живое обновление из CRDT', () => {
  it('без несохранённых правок молча показывает пришедший текст', () => {
    const { textarea, rerender } = setup('старый текст')
    rerender('текст соавтора')

    expect(textarea().value).toBe('текст соавтора')
    // Никаких предупреждений: затирать было нечего.
    expect(screen.queryByText(/Соавтор изменил текст/)).toBeNull()
  })

  it('не затирает несохранённый черновик, но предупреждает и даёт кнопку', () => {
    const { textarea, type, rerender } = setup('начало')
    type(' мои правки')
    expect(textarea().value).toBe('начало мои правки')

    rerender('текст соавтора')

    // Черновик цел.
    expect(textarea().value).toBe('начало мои правки')
    expect(screen.getByText(/Соавтор изменил текст/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'взять версию соавтора' })).toBeInTheDocument()
  })

  it('«взять версию соавтора» — явное действие: подставляет текст и пишет в CRDT', () => {
    const { textarea, type, rerender, onAdopt } = setup('начало')
    type(' плюс моё')
    rerender('текст соавтора')

    fireEvent.click(screen.getByRole('button', { name: 'взять версию соавтора' }))

    expect(textarea().value).toBe('текст соавтора')
    expect(onAdopt).toHaveBeenCalledWith('текст соавтора')
    // После принятия чужой версии конфликта нет: она и есть база.
    expect(screen.queryByText(/Соавтор изменил текст/)).toBeNull()
  })

  it('после сохранения значение из CRDT снова базовое, конфликта нет', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const view = render(
      <MarkdownEditor value="старое" onSave={onSave} onAdopt={() => {}} onClose={onClose} />,
    )
    const textarea = () => screen.getByLabelText('Текст события в Markdown') as HTMLTextAreaElement
    fireEvent.change(textarea(), { target: { value: 'старое!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить текст' }))

    expect(onSave).toHaveBeenCalledWith('старое!')
    expect(onClose).toHaveBeenCalled()

    // Родитель записал текст в CRDT и вернул его же как value — как это делает
    // EventEditor после сохранения. Предупреждения быть не должно.
    view.rerender(
      <MarkdownEditor value="старое!" onSave={onSave} onAdopt={() => {}} onClose={onClose} />,
    )
    expect(screen.queryByText(/Соавтор изменил текст/)).toBeNull()
  })

  it('правка чужого поля (значение не менялось) окно не трогает', () => {
    const { textarea, rerender } = setup('текст')
    rerender('текст')
    expect(textarea().value).toBe('текст')
    expect(screen.queryByText(/Соавтор изменил текст/)).toBeNull()
  })

  it('эхо собственного черновика из CRDT не считается конфликтом', () => {
    const { textarea, type, rerender } = setup('начало')
    type(' плюс')
    const typed = textarea().value

    // Апдейт вернулся с тем же текстом (наша же запись): предупреждать не о чем.
    rerender(typed)
    expect(screen.queryByText(/Соавтор изменил текст/)).toBeNull()
  })

  it('серия чужих правок не подменяет черновик, а кнопка берёт самую свежую версию', () => {
    const { textarea, type, rerender } = setup('начало')
    type(' моё')

    rerender('соавтор-1')
    rerender('соавтор-2')

    // Предупреждение одно и то же, черновик по-прежнему наш.
    expect(screen.getAllByText(/Соавтор изменил текст/)).toHaveLength(1)
    expect(textarea().value).toBe('начало моё')

    fireEvent.click(screen.getByRole('button', { name: 'взять версию соавтора' }))
    expect(textarea().value).toBe('соавтор-2')
  })

  it('чужое удаление текста при живом черновике тоже проходит через предупреждение', () => {
    const { textarea, type, rerender } = setup('начало')
    type(' моё')
    // Соавтор стёр текст целиком: молча «вернуть» его в поле нельзя.
    rerender('')

    expect(textarea().value).toBe('начало моё')
    expect(screen.getByText(/Соавтор изменил текст/)).toBeInTheDocument()
  })
})
